"""User skill library: SKILL.md skills (+ bundles) under ~/.cache/mtapi/skills.

Pure storage helpers — no FastAPI, no subprocess. The model-assisted install
op (`operations/skills_ops.py`) and thin read routes (`routes/skills.py`)
both build on this module. Orthogonal to named projects: never written into
*.ffproject.json (same class as the prompt library).
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

INDEX_VERSION = 1
MAX_SKILLS = 200
MAX_SINGLE_BYTES = 200 * 1024
MAX_ZIP_BYTES = 5 * 1024 * 1024
MAX_ZIP_FILES = 50
MAX_MEMBER_BYTES = 200 * 1024
MAX_DETAIL_BYTES = 500 * 1024
ENTRY_NAME = "SKILL.md"

_lock = threading.Lock()


def _cache_root() -> Path:
    env = os.environ.get("MTAPI_SKILLS_ROOT")
    if env:
        return Path(env).expanduser().resolve()
    try:
        from .media.config import MEDIA_ROOT
        return MEDIA_ROOT.parent
    except Exception:
        return Path.home() / ".cache" / "mtapi"


def skills_dir() -> Path:
    return _cache_root() / "skills"


def index_path() -> Path:
    return _cache_root() / "skills.json"


def skill_dir(skill_id: str) -> Path:
    return skills_dir() / skill_id


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


# ── index ────────────────────────────────────────────────────────────────────

def _blank_index() -> dict:
    return {"version": INDEX_VERSION, "skills": []}


def load_index() -> dict:
    """Tolerant read: corrupt/missing index → blank (never raise, never wipe)."""
    try:
        raw = index_path().read_text(encoding="utf-8")
        data = json.loads(raw)
        if isinstance(data, dict) and isinstance(data.get("skills"), list):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return _blank_index()


def _write_index(data: dict) -> None:
    root = _cache_root()
    root.mkdir(parents=True, exist_ok=True)
    tmp = index_path().with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, index_path())


def list_skills() -> list[dict]:
    with _lock:
        entries = list(load_index().get("skills") or [])
    entries.sort(key=lambda e: str(e.get("updated_at") or ""), reverse=True)
    return entries


def find_by_id(skill_id: str) -> dict | None:
    for e in load_index().get("skills") or []:
        if str(e.get("id")) == str(skill_id):
            return e
    return None


def find_by_name(name: str) -> dict | None:
    want = (name or "").strip().lower()
    if not want:
        return None
    for e in load_index().get("skills") or []:
        if str(e.get("name") or "").strip().lower() == want:
            return e
    return None


def upsert_skill(entry: dict) -> dict:
    """Insert or replace by id. Enforces the MAX_SKILLS cap on new names."""
    with _lock:
        data = load_index()
        skills = [e for e in (data.get("skills") or []) if str(e.get("id")) != str(entry.get("id"))]
        if len(skills) >= MAX_SKILLS:
            raise ValueError(
                f"Skill library is full ({MAX_SKILLS} entries) — delete one first"
            )
        entry = dict(entry)
        entry["updated_at"] = _now_iso()
        if not entry.get("created_at"):
            entry["created_at"] = entry["updated_at"]
        skills.append(entry)
        data["skills"] = skills
        _write_index(data)
    return entry


def delete_skill(skill_id: str) -> bool:
    with _lock:
        data = load_index()
        skills = [e for e in (data.get("skills") or []) if str(e.get("id")) != str(skill_id)]
        if len(skills) == len(data.get("skills") or []):
            return False
        data["skills"] = skills
        _write_index(data)
    # Best-effort file removal (index is the truth; a stray dir must not fail the op)
    d = skill_dir(skill_id)
    try:
        if d.is_dir():
            import shutil
            shutil.rmtree(d)
    except Exception:
        pass
    return True


def new_entry(name: str, description: str, source: str, files: dict[str, str]) -> dict:
    now = _now_iso()
    return {
        "id": uuid.uuid4().hex,
        "name": name,
        "description": description,
        "source": source,
        "files": dict(files),
        "entry": ENTRY_NAME,
        "created_at": now,
        "updated_at": now,
    }


def write_skill_files(skill_id: str, files: dict[str, str]) -> None:
    """Write decoded text files under skills/{id}/. Keys are already sanitized."""
    base = skill_dir(skill_id)
    base.mkdir(parents=True, exist_ok=True)
    for rel, text in files.items():
        dest = (base / rel).resolve()
        if dest != base.resolve() and base.resolve() not in dest.parents:
            raise ValueError(f"Unsafe skill path: {rel!r}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")


def read_skill_files(skill_id: str) -> dict[str, str]:
    entry = find_by_id(skill_id)
    if not entry:
        raise KeyError(skill_id)
    base = skill_dir(skill_id)
    out: dict[str, str] = {}
    total = 0
    for rel in (entry.get("files") or {}).keys():
        dest = (base / rel).resolve()
        if dest != base.resolve() and base.resolve() not in dest.parents:
            continue
        try:
            text = dest.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            text = ""
        total += len(text.encode("utf-8", errors="replace"))
        if total > MAX_DETAIL_BYTES:
            raise ValueError("Skill too large to display (>500 KB)")
        out[rel] = text
    return out


# ── frontmatter + names ──────────────────────────────────────────────────────

_FRONTMATTER_RE = re.compile(r"\A\s*---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[str | None, str | None, str]:
    """Return (name, description, body). Name/description are None when absent."""
    m = _FRONTMATTER_RE.match(text or "")
    if not m:
        return None, None, (text or "")
    name = desc = None
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        val = val.strip().strip("'\"").strip()
        if key.strip().lower() == "name" and val:
            name = val
        elif key.strip().lower() == "description" and val:
            desc = val
    return name, desc, (text[m.end():])


def slugify_name(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return slug[:64]


def derive_description(body: str) -> str:
    for line in (body or "").splitlines():
        line = re.sub(r"^#+\s*", "", line.strip()).strip()
        if line:
            return line[:160]
    return "Imported skill"


# ── zip bundles ──────────────────────────────────────────────────────────────

def _safe_rel(name: str) -> str | None:
    """Zip member → safe relative path, or None to skip/reject."""
    if not name or name.startswith("/") or name.startswith("\\"):
        return None
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    # Skip directories, hidden files, and junk
    last = parts[-1]
    if name.endswith("/"):
        return None
    if last.startswith(".") or last in ("__MACOSX", ".DS_Store"):
        return None
    if parts[0] == "__MACOSX":
        return None
    return "/".join(parts)


def extract_skill_zip(zip_bytes: bytes) -> tuple[str, dict[str, str]]:
    """Return (entry_text, extra_files). Raises ValueError on any violation."""
    if len(zip_bytes) > MAX_ZIP_BYTES:
        raise ValueError(f"Zip too large (>{MAX_ZIP_BYTES // (1024 * 1024)} MB)")
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile:
        raise ValueError("Not a valid .zip file")
    with zf:
        members = [i for i in zf.infolist() if not i.is_dir()]
        if len(members) > MAX_ZIP_FILES:
            raise ValueError(f"Zip holds too many files (>{MAX_ZIP_FILES})")
        files: dict[str, str] = {}
        for info in members:
            if info.file_size > MAX_MEMBER_BYTES:
                raise ValueError(f"Zip member too large: {info.filename!r}")
            rel = _safe_rel(info.filename)
            if rel is None:
                # Absolute / traversal members reject the whole install
                raw = info.filename or ""
                if ".." in raw.replace("\\", "/").split("/") or raw.startswith(("/", "\\")):
                    raise ValueError(f"Unsafe zip member: {raw!r}")
                continue
            with zf.open(info) as fh:
                files[rel] = fh.read().decode("utf-8", errors="replace")
    if not files:
        raise ValueError("Zip contains no usable files")
    entry_key = None
    for key in files:
        if key == ENTRY_NAME or key.endswith("/" + ENTRY_NAME):
            depth = key.count("/")
            if depth == 0:
                entry_key = key
                break
            if depth == 1 and entry_key is None:
                entry_key = key
    if entry_key is None:
        raise ValueError("No SKILL.md found at zip root or one level down")
    entry_text = files.pop(entry_key)
    # Re-root one-level-down bundles so files sit next to SKILL.md
    prefix = entry_key[: -len(ENTRY_NAME)]
    if prefix:
        files = {k[len(prefix):]: v for k, v in files.items() if k.startswith(prefix)}
    return entry_text, files


def decode_zip_b64(content_b64: str) -> bytes:
    try:
        return base64.b64decode(content_b64, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("content_b64 is not valid base64")
