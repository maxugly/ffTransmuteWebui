from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .modes import MODES, ScoreFn

log = logging.getLogger("mtapi.image_sort")

SortOrder = Literal["nearest_first", "farthest_first"]


@dataclass
class RankedItem:
    path: Path
    score: float
    rank: int


@dataclass
class RankResult:
    ordered_paths: list[str] = field(default_factory=list)
    items: list[dict] = field(default_factory=list)


def rank_images(
    base: str | Path,
    targets: list[str | Path],
    mode: str = "phash",
    order: SortOrder = "nearest_first",
) -> list[RankedItem]:
    base_path = Path(base).expanduser().resolve()
    if not base_path.is_file():
        raise FileNotFoundError(f"Base image not found: {base_path}")

    score_fn = MODES.get(mode)
    if score_fn is None:
        available = sorted(MODES.keys())
        raise ValueError(
            f"Unknown sort_mode {mode!r}. Available: {', '.join(available)}"
        )

    target_paths: list[Path] = []
    for t in targets:
        tp = Path(t).expanduser().resolve()
        if tp == base_path:
            continue
        if tp.is_file():
            target_paths.append(tp)
        else:
            log.warning("Skipping unreadable target: %s", t)

    if not target_paths:
        raise ValueError("No readable targets found after collecting and excluding base")

    scored: list[tuple[Path, float]] = []
    for tp in target_paths:
        try:
            s = score_fn(base_path, tp)
            scored.append((tp, s))
        except Exception:
            log.warning("Skipping unreadable target during scoring: %s", tp)
            continue

    if not scored:
        raise ValueError("No targets survived scoring")

    reverse = order == "farthest_first"
    scored.sort(key=lambda x: x[1], reverse=reverse)

    return [
        RankedItem(path=p, score=s, rank=i)
        for i, (p, s) in enumerate(scored)
    ]


def rank_images_full(
    paths: list[str | Path],
    mode: str = "phash",
    order: SortOrder = "nearest_first",
) -> RankResult:
    """Rank targets vs paths[0]; return structured result for UI rank endpoint."""
    if len(paths) < 2:
        raise ValueError("Need at least 2 images to rank")

    base = str(Path(paths[0]).expanduser().resolve())
    targets = [str(Path(p).expanduser().resolve()) for p in paths[1:]]

    ranked = rank_images(base, targets, mode=mode, order=order)

    items: list[dict] = [
        {"path": base, "score": None, "role": "base"},
    ]
    for item in ranked:
        items.append({
            "path": str(item.path),
            "score": round(item.score, 2),
            "role": "target",
        })

    ordered_paths = [base] + [str(item.path) for item in ranked]

    return RankResult(
        ordered_paths=ordered_paths,
        items=items,
    )
