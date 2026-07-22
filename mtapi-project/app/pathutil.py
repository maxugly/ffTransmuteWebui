"""
Never-overwrite output paths with ascending sequence numbers.

Examples:
  photo_dream.png          # used if free
  photo_dream_0001.png     # next free
  photo_dream_0002.png

Related siblings (cutout + mask + bg) share the same sequence so they stay grouped.

Rule of thumb for ops:
  dest = default_next_to_source(src, suffix="_styled", ext=".png")
  dest = finalize_output_path(dest)   # ext + unique + mkdir parent
"""
from __future__ import annotations

import re
from pathlib import Path

_SEQ_RE = re.compile(r"^(?P<base>.*)_(\d+)$")


def strip_seq_suffix(stem: str) -> str:
    """photo_dream_0003 → photo_dream; plain stem unchanged."""
    m = _SEQ_RE.match(stem)
    return m.group("base") if m else stem


def default_next_to_source(
    source: str | Path,
    *,
    suffix: str = "",
    ext: str = ".png",
    output_dir: str | Path | None = None,
) -> Path:
    """
    Build the preferred output path next to `source` (or under output_dir).

    Does **not** allocate a free name — call finalize_output_path / unique_output_path after.
    """
    src = Path(source).expanduser()
    parent = Path(output_dir).expanduser() if output_dir else src.parent
    # If caller passed a file as "output_dir", use its parent
    if parent.is_file():
        parent = parent.parent
    if not ext.startswith("."):
        ext = f".{ext}"
    return parent / f"{src.stem}{suffix}{ext}"


def finalize_output_path(
    path: str | Path | None,
    *,
    source: str | Path | None = None,
    default_suffix: str = "",
    default_ext: str = ".png",
    output_dir: str | Path | None = None,
    allowed_exts: set[str] | frozenset[str] | None = None,
    digits: int = 4,
) -> Path:
    """
    Resolve a never-overwrite output path.

    - If `path` is missing/blank → `{source_dir or output_dir}/{stem}{suffix}{ext}`.
    - If `path` is a directory (exists or ends with `/`) → name file inside it from source.
    - Missing/wrong extension → `default_ext` (or allowed set).
    - Always returns a path that does **not** exist yet (`_0001`, `_0002`, …).
    - Creates the parent directory.
    """
    if default_ext and not str(default_ext).startswith("."):
        default_ext = f".{default_ext}"
    src = Path(source).expanduser() if source else None
    od = Path(output_dir).expanduser() if output_dir else None
    if od is not None and od.is_file():
        od = od.parent

    raw = (str(path).strip() if path is not None else "") or ""

    if not raw:
        if src is None:
            raise ValueError("finalize_output_path needs source when path is omitted")
        p = default_next_to_source(
            src, suffix=default_suffix, ext=default_ext, output_dir=od
        )
    else:
        p = Path(raw).expanduser()
        is_dir_target = p.is_dir() or raw.endswith(("/", "\\"))
        if is_dir_target:
            if src is None:
                raise ValueError("directory output needs a source file to name against")
            p = default_next_to_source(
                src, suffix=default_suffix, ext=default_ext, output_dir=p
            )
        elif od is not None and not p.is_absolute():
            p = od / p.name

    # Normalize extension
    ext = p.suffix.lower()
    if allowed_exts is None:
        allowed = {default_ext.lower()} if default_ext else set()
    else:
        allowed = {
            (e if e.startswith(".") else f".{e}").lower() for e in allowed_exts
        }
    if not ext or (allowed and ext not in allowed):
        p = p.with_suffix(default_ext if default_ext else ".png")

    p.parent.mkdir(parents=True, exist_ok=True)
    return unique_output_path(p, digits=digits)


def _highest_seq_for_base(parent: Path, base: str, suffix: str) -> int:
    """
    Highest far-right version number used by siblings of `{base}{suffix}` /
    `{base}_NNNN…`. Returns 0 if only the unnumbered base exists (or nothing
    numbered yet); -1 if the parent is missing / empty of matches.
    """
    if not parent.is_dir():
        return -1
    prefix = f"{base}_"
    highest = -1
    base_file = parent / f"{base}{suffix}"
    if base_file.exists():
        highest = 0
    try:
        for child in parent.iterdir():
            if not child.is_file():
                continue
            # Same extension family only (png vs png); empty suffix = any
            if suffix and child.suffix.lower() != suffix.lower():
                continue
            cs = child.stem
            if cs == base:
                highest = max(highest, 0)
                continue
            if cs.startswith(prefix):
                rest = cs[len(prefix) :]
                # far-right version: leading digits only (allow "0001-mask")
                m = re.match(r"^(\d+)", rest)
                if m:
                    highest = max(highest, int(m.group(1)))
    except OSError:
        pass
    return highest


def unique_output_path(
    path: str | Path,
    *,
    digits: int = 4,
    prefer_unnumbered: bool = True,
) -> Path:
    """
    Return a path that does not already exist on disk.

    - If the exact `path` is free → return it.
    - On collision → always bump the **far-right** ``_NNNN`` sequence on the
      stem base (strip one trailing ``_digits`` group first), e.g.::

        clip_last.png        → clip_last_0001.png
        clip_last_0001.png   → clip_last_0002.png   (never jumps back to free unnumbered)

    `prefer_unnumbered` is kept for API compat; collisions never fall back to a
    free unnumbered name when a numbered sibling already exists or the exact
    path is taken.
    """
    p = Path(path).expanduser()
    parent = p.parent
    stem = p.stem
    suffix = p.suffix
    base = strip_seq_suffix(stem)

    # Exact path free → use it (first export, or explicit free Save As name)
    if not p.exists():
        return p

    # Collision: next far-right version only
    highest = _highest_seq_for_base(parent, base, suffix)
    n = 1 if highest < 0 else highest + 1
    if n < 1:
        n = 1

    while True:
        candidate = parent / f"{base}_{n:0{digits}d}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1
        if n > 999_999:
            raise RuntimeError(f"Could not allocate unique path near {p}")


def unique_related_paths(
    paths: dict[str, Path],
    *,
    primary_key: str | None = None,
    digits: int = 4,
    prefer_unnumbered: bool = True,
) -> dict[str, Path]:
    """
    Allocate a free sequence for a group of related outputs.

    `paths` maps role → desired path, e.g.:
      cutout → .../withoutbg-photo.png
      mask   → .../withoutbg-photo-mask.png
      background → .../withoutbg-photo-bg.png

    All share the same `_NNNN` inserted before variant tags when numbering
    is needed, so a set never partially overwrites.
    """
    if not paths:
        return {}

    keys = list(paths.keys())
    primary_key = primary_key if primary_key in paths else keys[0]
    primary = Path(paths[primary_key])
    parent = primary.parent
    suffix = primary.suffix

    # Infer common base + per-key variant suffix from filenames
    # e.g. withoutbg-photo.png vs withoutbg-photo-mask.png → base=withoutbg-photo, variants "" / "-mask"
    stems = {k: Path(v).stem for k, v in paths.items()}
    # longest common prefix of stems as base candidate
    stem_list = list(stems.values())
    base = stem_list[0]
    for s in stem_list[1:]:
        while not s.startswith(base) and base:
            base = base[:-1]
        if not base:
            base = strip_seq_suffix(stems[primary_key])
            break
    # trim base if it ends mid-token oddly; prefer strip_seq of primary
    if not base or len(base) < 1:
        base = strip_seq_suffix(stems[primary_key])
    base = strip_seq_suffix(base.rstrip("-_"))

    variants: dict[str, str] = {}
    for k, st in stems.items():
        if st == base or st.startswith(base):
            variants[k] = st[len(base) :]  # "" or "-mask" or "-bg"
        else:
            variants[k] = ""

    def make(n: int | None) -> dict[str, Path]:
        out: dict[str, Path] = {}
        for k, v in paths.items():
            p = Path(v)
            var = variants.get(k, "")
            if n is None:
                stem = f"{base}{var}"
            else:
                stem = f"{base}_{n:0{digits}d}{var}"
            out[k] = p.parent / f"{stem}{p.suffix}"
        return out

    # Prefer unnumbered set if none of the targets exist
    if prefer_unnumbered:
        unnumbered = make(None)
        if not any(p.exists() for p in unnumbered.values()):
            return unnumbered

    # Find next free sequence (none of the related files exist)
    n = 1
    if parent.is_dir():
        highest = 0
        prefix = f"{base}_"
        try:
            for child in parent.iterdir():
                if not child.is_file():
                    continue
                cs = child.stem
                if cs == base or cs.startswith(base + "-") or cs.startswith(base + "_"):
                    m = re.match(re.escape(base) + r"_(\d+)", cs)
                    if m:
                        highest = max(highest, int(m.group(1)))
                    elif cs == base or cs.startswith(base + "-"):
                        highest = max(highest, 0)
        except OSError:
            pass
        if highest or any(p.exists() for p in make(None).values()):
            n = highest + 1 if highest else 1

    while n < 1_000_000:
        candidate = make(n)
        if not any(p.exists() for p in candidate.values()):
            return candidate
        n += 1
    raise RuntimeError(f"Could not allocate unique related paths near {primary}")
