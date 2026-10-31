"""Cached HF discovery. Never load weights or change serving settings here."""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from .config import ModelEntry, PROJECT_ROOT, load_config, settings_path

DAY = 86400
_LOCK = threading.RLock()
_refresh = {'state': 'idle'}
ROOT = PROJECT_ROOT / 'junk' / 'hf-openvino-models'
META = PROJECT_ROOT / 'junk' / 'hf-openvino-metadata'
REQUIRED = ('openvino_model.xml', 'openvino_model.bin', 'openvino_tokenizer.xml',
            'openvino_tokenizer.bin', 'openvino_detokenizer.xml', 'openvino_detokenizer.bin',
            'config.json', 'tokenizer_config.json')
OPTIONAL = ('generation_config.json', 'chat_template.jinja', 'tokenizer.json',
            'special_tokens_map.json', 'added_tokens.json', 'vocab.json', 'merges.txt',
            'tokenizer.model', 'compression.json', 'sentencepiece.bpe.model')
# Conservative GPU allowlist; other complete text exports remain experimental.
GPU_ARCH = {'Qwen3ForCausalLM', 'Qwen2ForCausalLM', 'LlamaForCausalLM', 'Phi3ForCausalLM', 'MistralForCausalLM'}


def atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{threading.get_ident()}.tmp')
    tmp.write_text(json.dumps(data, indent=2), encoding='utf-8')
    tmp.replace(path)


def read(path, default=None):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def cache_path():
    return settings_path().with_name('hf-catalog.json')


def snapshot():
    cached = read(cache_path(), {})
    with _LOCK:
        status = dict(_refresh)
    stamp = cached.get('updated_at', 0)
    return {'models': cached.get('models', []), 'updated_at': stamp,
            'stale': time.time() - stamp >= DAY, 'refresh': status}


def safe_error(exc):
    # Do not leak authentication headers, signed URLs or environment tokens.
    name = type(exc).__name__
    status = getattr(getattr(exc, 'response', None), 'status_code', None)
    if status in (401, 403) or 'GatedRepo' in name:
        return 'HF access denied. Check your HF login and accept any required model license on Hugging Face.'
    if status == 429:
        return 'HF rate limit reached. Cached models remain available; retry later.'
    return f'Hugging Face request failed ({name}). Cached models remain available; retry when connected.'


def memory_bytes(value):
    match = re.fullmatch(r'(\d+(?:\.\d+)?)([KMGTP]?)(?:i?B)?', str(value).strip(), re.I)
    if not match:
        return 0
    return int(float(match[1]) * 1024 ** (' KMGTP'.index(match[2].upper()) if match[2] else 0))


def suitability(row, cfg=None):
    cfg = cfg or load_config()
    c = row.get('model_config', {})
    weights = row.get('weight_bytes') or 0
    arch = set(c.get('architectures') or [])
    kv = None
    try:
        layers = int(c['num_hidden_layers'])
        heads = int(c.get('num_key_value_heads', c['num_attention_heads']))
        dim = int(c.get('head_dim') or int(c['hidden_size']) // int(c['num_attention_heads']))
        context = min(8192, int(c.get('max_position_embeddings') or 8192))
        if not (0 < layers <= 512 and 0 < heads <= 512 and 0 < dim <= 4096 and context > 0):
            raise ValueError('Invalid model dimensions')
        kv = 2 * layers * heads * dim * context * .5
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        pass
    from .cage import mem_available_mb
    _, total_mb = mem_available_mb()
    cap = min(memory_bytes(cfg.cage.memory_max) or 9 * 1024**3, max(0, total_mb - 4096) * 1024**2)
    estimate = int(weights * 1.3 + 1024**3 + (kv or 0)) if weights else None
    reasons = []
    if not arch.intersection(GPU_ARCH):
        reasons.append('Architecture/device compatibility has not been established for this engine')
    if kv is None or not weights:
        reasons.append('Insufficient metadata for a complete memory estimate')
    if estimate and (not cap or estimate > cap * .9):
        reasons.append('Estimated memory is close to or above the available model budget')
    return {'experimental': bool(reasons), 'label': 'Experimental · untested' if reasons else 'Likely fits · untested',
            'estimated_memory_bytes': estimate, 'budget_bytes': cap,
            'explanation': '; '.join(reasons) if reasons else 'Estimated for 8192 context, u4 KV and runtime overhead; loading and reply success are not yet verified.'}


def inspect_repo(api, repo):
    from huggingface_hub import hf_hub_download
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo):
        return None
    info = api.model_info(repo, files_metadata=True, timeout=15)
    if info.pipeline_tag not in (None, 'text-generation'):
        return None
    files = {f.rfilename: f.size for f in info.siblings}
    if any(not files.get(n) for n in REQUIRED):
        return None
    if any(n.startswith('openvino_') and ('vision' in n or 'language_model' in n) for n in files):
        return None
    def metadata(name):
        if name not in files or (files[name] or 0) > 4 * 1024**2:
            return None
        return Path(hf_hub_download(repo, name, revision=info.sha, cache_dir=str(META))).read_text(encoding='utf-8')
    config = json.loads(metadata('config.json') or '{}')
    if not isinstance(config, dict):
        return None
    try:
        native = int(config.get('max_position_embeddings') or 8192)
        if not 512 <= native <= 2097152:
            return None
        config['max_position_embeddings'] = native
    except (TypeError, ValueError):
        return None
    tokenizer = json.loads(metadata('tokenizer_config.json') or '{}')
    if not isinstance(tokenizer, dict):
        return None
    template = metadata('chat_template.jinja') or tokenizer.get('chat_template') or ''
    if not isinstance(template, str) or not template.strip():
        return None
    compression = json.loads(metadata('compression.json') or '{}')
    required = list(REQUIRED) + [n for n in OPTIONAL if n in files]
    thinking = bool(re.search(r'{%-?\s*(?:if|elif)\s+[^{}]*\benable_thinking\b', template))
    tools = '<tool_call>' in template and 'tools' in template
    return {'repo_id': repo, 'revision': info.sha, 'files': {n: files[n] for n in required},
            'weight_bytes': files['openvino_model.bin'], 'download_bytes': sum(files[n] or 0 for n in required),
            'model_config': config, 'compression': compression,
            'supports_thinking_toggle': thinking, 'tools': tools,
            'reasoning': thinking or '<think>' in template,
            'variant': 'Heretic' if 'heretic' in repo.lower() else 'Abliterated' if 'abliterat' in repo.lower() else 'Standard'}


def _discover():
    from huggingface_hub import HfApi
    api = HfApi()  # HF_TOKEN / cached login; credentials never enter catalog JSON.
    repos = set()
    for sort, search, limit in [('downloads', None, 60), ('last_modified', None, 60),
                                ('downloads', 'heretic', 30), ('downloads', 'abliterated', 30)]:
        repos.update(m.id for m in api.list_models(filter='openvino', search=search, sort=sort, limit=limit))
    # Official cards often omit pipeline tags, so include model-family searches.
    for search, limit in [('qwen', 25), ('llama', 15), ('phi', 15)]:
        repos.update(m.id for m in api.list_models(filter='openvino', search=search, sort='downloads', limit=limit))
    return api, sorted(repos)


def adopt_configured_exports(rows):
    """Recognize existing HF downloads only when their pinned metadata agrees."""
    for entry in load_config().models:
        path = Path(entry.model_path)
        if manifest(path):
            continue
        source = next((r for r in rows if path.name == r['repo_id'].replace('/', '---') or entry.id == r['repo_id']), None)
        if not source:
            continue
        try:
            for name, size in source['files'].items():
                metadata = (path / '.cache/huggingface/download' / (name + '.metadata')).read_text().splitlines()
                if metadata[0] != source['revision'] or (path / name).stat().st_size != size:
                    break
            else:
                atomic(path / '.hf-model.json', {
                    'repo_id': source['repo_id'], 'revision': source['revision'], 'files': source['files'],
                    'preset_identity': f'local:{entry.id}:{entry.model_path}',
                    'export_metadata': {k: source[k] for k in ('model_config', 'compression', 'supports_thinking_toggle', 'tools', 'reasoning', 'variant', 'weight_bytes', 'download_bytes')}})
        except (OSError, IndexError):
            continue


def _run_refresh():
    try:
        api, repos = _discover()
        rows, failures, rejected = [], 0, 0
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = {pool.submit(inspect_repo, api, repo): repo for repo in repos}
            for index, future in enumerate(as_completed(futures), 1):
                try:
                    row = future.result()
                    if row:
                        rows.append(row)
                    else:
                        rejected += 1
                except Exception:
                    failures += 1
                with _LOCK:
                    _refresh.update(current=index, total=len(repos), found=len(rows))
        if not rows:
            raise RuntimeError('No valid exports discovered')
        # Retain previously known exports when individual repositories temporarily fail.
        old = {r['repo_id']: r for r in snapshot()['models']}
        old.update({r['repo_id']: r for r in rows})
        adopt_configured_exports(list(old.values()))
        atomic(cache_path(), {'updated_at': time.time(), 'models': sorted(old.values(), key=lambda r: r['repo_id'].lower())})
        with _LOCK:
            _refresh.update(state='complete', message=f'{len(rows)} exports checked; {rejected} incompatible/incomplete; {failures} unavailable.', finished_at=time.time())
    except Exception as exc:
        with _LOCK:
            _refresh.update(state='error', message=safe_error(exc), finished_at=time.time())


def start_refresh(force=False):
    with _LOCK:
        snap = snapshot()
        if _refresh['state'] == 'refreshing' or (not force and (not snap['stale'] or time.time() - _refresh.get('finished_at', 0) < 300)):
            return {'ok': True, **{k:v for k,v in snap.items() if k != 'models'}}
        _refresh.clear()
        _refresh.update(state='refreshing', current=0, total=None, found=0, message='Looking for OpenVINO exports…')
        threading.Thread(target=_run_refresh, daemon=True).start()
        return {'ok': True, **{k:v for k,v in snapshot().items() if k != 'models'}}


def manifest(path):
    value = read(Path(path) / '.hf-model.json', {})
    return value if isinstance(value, dict) else {}


def installed(row, path):
    saved = manifest(path)
    return (saved.get('repo_id') == row['repo_id'] and bool(saved.get('revision'))
            and all((Path(path) / name).is_file() and (Path(path) / name).stat().st_size == size
                    for name, size in saved.get('files', {}).items()) and bool(saved.get('files')))


def verification_key(entry, cfg, device=None, kv=None):
    saved = manifest(entry.model_path)
    if not saved:
        return None
    from .profiles import effective_runtime, RUNTIME_KEYS
    effective = effective_runtime(cfg, entry).model_dump(mode='json')
    runtime = {k: effective[k] for k in (*RUNTIME_KEYS, 'engine', 'runtime_overlay_path', 'ovms_tool_parser') if k in effective}
    runtime['device'] = device or runtime['device']
    runtime['kv_cache_precision'] = kv or runtime['kv_cache_precision']
    data = {'revision': saved['revision'], 'entry': entry.model_dump(mode='json'), 'runtime': runtime}
    data['artifacts'] = [(n, (Path(entry.model_path) / n).stat().st_mtime_ns) for n in saved['files']]
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def record_verified(entry, cfg, device, kv, request_settings):
    key = verification_key(entry, cfg, device, kv)
    if key:
        from .profiles import effective_runtime
        runtime = effective_runtime(cfg, entry).model_dump(mode='json')
        runtime.update(device=device, kv_cache_precision=kv)
        atomic(Path(entry.model_path) / '.hf-verified.json', {'key': key, 'revision': manifest(entry.model_path)['revision'],
               'device': device, 'settings': entry.model_dump(mode='json'), 'request_settings': request_settings,
               'runtime': runtime, 'verified_at': time.time()})


def model_dir(repo):
    legacy = ROOT / repo.replace('/', '---')
    if manifest(legacy).get('repo_id') == repo or read(legacy / '.hf-pending.json', {}).get('repo_id') == repo:
        return legacy
    suffix = hashlib.sha256(repo.encode()).hexdigest()[:12]
    return ROOT / (repo.replace('/', '---') + '--' + suffix)


def merge_rows(base):
    cfg = load_config()
    by_repo = {r['repo_id']: r for r in base}
    used_ids = {r['id'] for r in base}
    # Match configured custom paths by HF download metadata without moving their weights.
    paths = {}
    for entry in cfg.models:
        p = Path(entry.model_path)
        saved = manifest(p)
        if saved.get('repo_id'):
            paths[saved['repo_id']] = (entry, p)
        elif '---' in p.name:
            paths[p.name.replace('---', '/', 1)] = (entry, p)
    for source in snapshot()['models']:
        repo = source['repo_id']
        if repo in by_repo:
            by_repo[repo]['hf_revision'] = source['revision']
            continue  # Playground metadata and identities take precedence.
        path = model_dir(repo)
        ident = repo  # Full identity avoids author/name collisions.
        if repo in paths:
            existing, path = paths[repo]
            ident = existing.id
        else:
            existing = None
        saved = manifest(path)
        latest_revision = source['revision']
        if saved.get('export_metadata') and installed(source, path):
            source = {**source, **saved['export_metadata'], 'files': saved['files']}
        fit = suitability(source, cfg)
        native = int(source['model_config'].get('max_position_embeddings') or 8192)
        entry = existing or ModelEntry(id=ident, model_path=str(path), context_window=min(native, 8192),
             max_tokens=min(native, 512), max_tokens_default=min(native, 128), temperature_default=.7,
             top_p_default=None, capabilities={'streaming': True, 'tools': source['tools'],
             'reasoning': source['reasoning'], 'vision': False, 'prompt_cache': True},
             runtime_profiles={'playground': {'device': 'GPU', 'kv_cache_precision': 'u4'}})
        saved = manifest(path)
        # Installed snapshot, not a newer discovery, controls this model until explicitly replaced.
        present = installed(source, path) or bool(existing and all((path / n).is_file() and (path / n).stat().st_size for n in REQUIRED))
        verify = read(path / '.hf-verified.json', {})
        verified = False
        if present:
            try:
                verified = verify.get('key') == verification_key(entry, cfg)
            except OSError:
                pass
        if ident in used_ids:
            ident = repo
            entry = entry.model_copy(update={'id': ident})
        used_ids.add(ident)
        by_repo[repo] = {**source, 'id': ident, 'source': 'hf', 'model_path': str(path),
            'revision': saved.get('revision', source['revision']) if present else source['revision'],
            'update_available': bool(saved.get('revision') and saved['revision'] != latest_revision),
            'installed': present, 'native_context_window': native, 'supports_vision': False,
            'npu_support': False, 'selectable': cfg.runtime.engine == 'playground',
            'unavailable_reason': 'Select Playground OVMS for HF exports',
            'preset_identity': saved.get('preset_identity') or (f'local:{existing.id}:{existing.model_path}' if existing and not saved else repo),
            'suitability': fit, 'verified': verified, 'verification': verify if verified else None,
            'entry': entry.model_dump(mode='json')}
    return list(by_repo.values())
