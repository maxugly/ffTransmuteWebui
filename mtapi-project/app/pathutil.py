"""
Never-overwrite output paths with ascending sequence numbers.

Examples:
  photo_dream.png          # used if free
  photo_dream_0001.png     # next free
  photo_dream_0002.png

Related siblings (cutout + mask + bg) share the same sequence so they stay grouped.
"""
from __future__ import annotations

import re
from pathlib import Path

_SEQ_RE = re.compile(r"^(?P<base>.*)_(\d+)$")


def strip_seq_suffix(stem: str) -> str:
    """photo_dream_0003 → photo_dream; plain stem unchanged."""
    m = _SEQ_RE.match(stem)
    return m.group("base") if m else stem


def unique_output_path(
    path: str | Path,
    *,
    digits: int = 4,
    prefer_unnumbered: bool = True,
) -> Path:
    """
    Return a path that does not already exist on disk.

    If `path` is free and prefer_unnumbered, return it.
    Otherwise return `{stem}_{NNNN}{suffix}` with the smallest free N ≥ 1.
    Scans existing `{stem}_*` siblings so numbering keeps ascending.
    """
    p = Path(path).expanduser()
    # Don't resolve() yet — parent may not exist; only normalize later for checks
    parent = p.parent
    stem = p.stem
    suffix = p.suffix
    base = strip_seq_suffix(stem)

    if prefer_unnumbered:
        candidate = parent / f"{base}{suffix}"
        if not candidate.exists():
            return candidate

    n = 1
    # Jump past highest existing sequence for this base
    if parent.is_dir():
        prefix = f"{base}_"
        highest = 0
        try:
            for child in parent.iterdir():
                if not child.is_file():
                    continue
                if child.suffix.lower() != suffix.lower():
                    # still count same stem family even if ext differs? skip
                    pass
                cs = child.stem
                if cs == base:
                    highest = max(highest, 0)
                    continue
                if cs.startswith(prefix):
                    rest = cs[len(prefix) :]
                    # allow rest like "0001" or "0001-mask" → take leading digits
                    m = re.match(r"^(\d+)", rest)
                    if m:
                        highest = max(highest, int(m.group(1)))
        except OSError:
            pass
        n = max(1, highest + 1) if highest or (parent / f"{base}{suffix}").exists() else 1

    # Find first free from n
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
