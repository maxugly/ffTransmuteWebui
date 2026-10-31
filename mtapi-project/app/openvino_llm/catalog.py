"""Read Intel AI Playground's OpenVINO catalog and reuse its model storage.

Bundled fallback is a snapshot of the installed Playground catalog (2026-10-23).
No weights are loaded or downloaded by catalog discovery.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Any

from .. import job_control
from .config import ModelEntry, load_config

_DOWNLOAD_LOCK = threading.Lock()
_download: dict[str, Any] = {"state": "idle"}


def resources_dir() -> Path:
    return Path(os.environ.get(
        "MTAPI_AI_PLAYGROUND_RESOURCES",
        str(Path.home() / ".local/share/ai-playground/resources"),
    )).expanduser().resolve()


def _read_catalog() -> tuple[list, str, str | None]:
    source = resources_dir() / "models.json"
    try:
        rows = json.loads(source.read_text(encoding="utf-8"))
        if not isinstance(rows, list):
            raise ValueError("models.json must contain an array")
        return rows, str(source), None
    except (OSError, ValueError) as exc:
        fallback = Path(__file__).with_name("playground-models.json")
        rows = json.loads(fallback.read_text(encoding="utf-8"))
        return rows, str(fallback), f"Using bundled Playground catalog: {exc}"


def models_root() -> Path:
    resources = resources_dir()
    try:
        paths = json.loads((resources / "model_config.json").read_text(encoding="utf-8"))
        root = Path(paths["openvinoLLM"]).expanduser()
        # Playground paths are relative to the application folder, above resources/.
        return (root if root.is_absolute() else resources.parent / root).resolve()
    except (OSError, ValueError, KeyError, TypeError):
        return resources / "models/LLM/openvino"


def model_installed(path: Path, *, vision: bool = False) -> bool:
    prefix = "openvino_language_model" if vision else "openvino_model"
    required = (f"{prefix}.xml", f"{prefix}.bin", "config.json", "openvino_tokenizer.xml")
    return all((path / name).is_file() and (path / name).stat().st_size > 0 for name in required)


def model_catalog() -> dict[str, Any]:
    rows, source, warning = _read_catalog()
    root = models_root()
    native_server = load_config().runtime.engine == "playground"
    models = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or str(row.get("type", "")).lower() != "openvino":
            continue
        repo = str(row.get("name", ""))
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo) or repo in seen:
            continue
        seen.add(repo)
        model_id = repo.split("/")[1]
        path = root / repo.replace("/", "---")
        vision = bool(row.get("supportsVision"))
        native_context = int(row.get("maxContextSize") or 4096)
        # Catalog limits describe model capacity, not a safe payload budget.
        # Keep initial advertised context bounded on this shared-memory machine.
        entry = ModelEntry(
            id=model_id, model_path=str(path),
            context_window=min(native_context, 40960),
            max_tokens=min(native_context, 4096),
            tool_parser=str(row.get("toolParser") or "hermes3"),
            capabilities={
                "streaming": True, "tools": bool(row.get("supportsToolCalling")),
                "reasoning": bool(row.get("supportsReasoning")),
                "vision": vision and native_server, "prompt_cache": True,
            },
        )
        models.append({
            "id": model_id, "repo_id": repo, "model_path": str(path),
            "installed": model_installed(path, vision=vision),
            "native_context_window": native_context,
            "supports_vision": vision,
            "supports_thinking_toggle": bool(row.get("supportsThinkingToggle")),
            "npu_support": bool(row.get("npuSupport")),
            "selectable": native_server or not vision,
            "unavailable_reason": "Select the Playground OVMS engine to serve vision models" if vision and not native_server else None,
            "entry": entry.model_dump(mode="json"),
        })
    from . import hf_catalog
    models = hf_catalog.merge_rows(models)
    with _DOWNLOAD_LOCK:
        download = dict(_download)
    return {"ok": True, "source": source, "warning": warning, "models": models, "download": download, "hf": {k:v for k,v in hf_catalog.snapshot().items() if k != "models"}}


def _download_model(row: dict[str, Any], token: str) -> None:
    from . import hf_catalog as hf
    from huggingface_hub import HfApi, hf_hub_download
    from tqdm.auto import tqdm
    job_control.bind(token)
    path = Path(row['model_path'])
    try:
        pending = hf.read(path / '.hf-pending.json', {})
        if pending.get('repo_id') == row['repo_id']:
            revision, files = pending['revision'], pending['files']
        elif row.get('source') == 'hf':
            revision, files = row['revision'], row['files']
        else:
            info = HfApi().model_info(row['repo_id'], files_metadata=True, timeout=15)
            revision = info.sha
            files = {f.rfilename: f.size for f in info.siblings if
                     ((f.rfilename.startswith('openvino_') and f.rfilename.endswith(('.xml', '.bin')))
                      or f.rfilename in hf.REQUIRED + hf.OPTIONAL)}
        metadata = pending.get('export_metadata') or {k: row[k] for k in ('model_config', 'compression', 'supports_thinking_toggle', 'tools', 'reasoning', 'variant', 'weight_bytes', 'download_bytes') if k in row}
        total_bytes = sum(n or 0 for n in files.values())
        hf.atomic(path / '.hf-pending.json', {'repo_id': row['repo_id'], 'revision': revision, 'files': files, 'export_metadata': metadata})
        completed = 0
        def check():
            if job_control.is_cancelled(token):
                raise job_control.JobCancelled(token)
        class DownloadProgress(tqdm):
            def update(self, n=1):
                check()
                result = super().update(n)
                # Xet also reports compressed network bytes; only count logical file bytes.
                if self.total == files.get(name):
                    with _DOWNLOAD_LOCK:
                        _download.update(bytes_completed=min(completed + self.n, total_bytes), bytes_total=total_bytes)
                return result
        for index, name in enumerate(files):
            check()
            message = f'{index + 1}/{len(files)} files: {name}'
            with _DOWNLOAD_LOCK:
                _download.update(message=message, current=index, total=len(files), revision=revision,
                                 bytes_completed=completed, bytes_total=total_bytes)
            job_control.report_progress(message, token=token, phase='download', current=index, total=len(files), unit='files')
            hf_hub_download(repo_id=row['repo_id'], filename=name, revision=revision,
                            local_dir=str(path), tqdm_class=DownloadProgress)
            check()
            if files[name] and (path / name).stat().st_size != files[name]:
                raise ValueError('Downloaded file size mismatch')
            if files[name] is None:
                files[name] = (path / name).stat().st_size
                total_bytes += files[name]
            completed += files[name]
            job_control.report_progress(token=token, current=index + 1)
        if not model_installed(path, vision=row['supports_vision']):
            raise ValueError('Download incomplete: required OpenVINO files are missing')
        if row.get('source') == 'hf':
            for name in hf.REQUIRED:
                if not (path / name).is_file() or not (path / name).stat().st_size:
                    raise ValueError('Download incomplete')
            hf.atomic(path / '.hf-model.json', {'repo_id': row['repo_id'], 'revision': revision, 'files': files, 'export_metadata': metadata})
        (path / '.hf-pending.json').unlink(missing_ok=True)
        with _DOWNLOAD_LOCK:
            _download.update(state='complete', message='Download complete', current=len(files), bytes_completed=completed, bytes_total=total_bytes)
        job_control.finish(token, message='Download complete')
    except job_control.JobCancelled:
        with _DOWNLOAD_LOCK:
            _download.update(state='cancelled', message='Download cancelled. Retry resumes this revision.')
        job_control.finish(token, status='cancelled', message='Download cancelled')
    except Exception as exc:
        if job_control.is_cancelled(token):
            with _DOWNLOAD_LOCK:
                _download.update(state='cancelled', message='Download cancelled. Retry resumes this revision.')
            job_control.finish(token, status='cancelled', message='Download cancelled')
            return
        message = str(exc) if isinstance(exc, ValueError) else hf.safe_error(exc)
        with _DOWNLOAD_LOCK:
            _download.update(state='error', message=message)
        job_control.finish(token, status='error', message=message)
    finally:
        job_control.unregister(token)


def cancel_download():
    with _DOWNLOAD_LOCK:
        if _download['state'] == 'downloading':
            job_control.request_cancel(_download['token'])
            _download['message'] = 'Cancelling download…'
    return {'ok': True}


def start_download(model_id: str) -> dict[str, Any]:
    row = next((m for m in model_catalog()['models'] if m['id'] == model_id), None)
    if row is None:
        return {'ok': False, 'error': 'Choose a model from the catalog'}
    if row['installed']:
        return {'ok': True, 'installed': True}
    if not row['selectable']:
        return {'ok': False, 'error': row.get('unavailable_reason', 'Unsupported engine')}
    with _DOWNLOAD_LOCK:
        if _download['state'] == 'downloading':
            return {'ok': False, 'error': 'A model download is already running'}
        token = job_control.new_token()
        job_control.register(token, operation='openvino-model-download')
        _download.clear()
        _download.update(state='downloading', model_id=model_id, token=token, message='Fetching file list…', current=0, total=0)
        threading.Thread(target=_download_model, args=(row, token), daemon=True).start()
        return {'ok': True, 'download': dict(_download)}
