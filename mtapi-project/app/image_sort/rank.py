from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .modes import MODES, ScoreFn

log = logging.getLogger("mtapi.image_sort")

SortOrder = Literal["nearest_first", "farthest_first"]
SortStrategy = Literal["radial", "chain"]


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


def rank_images_chain(
    paths: list[str | Path],
    mode: str = "phash",
    order: SortOrder = "nearest_first",
) -> list[RankedItem]:
    """Greedy nearest-neighbor (or farthest-neighbor) walk through targets.

    Starts at paths[0] as the chain head, then repeatedly appends the unused
    image closest (or farthest) to the current end of the chain.

    Scores returned on each RankedItem are the step distance to the
    previous image in the walk (not distance to the base).
    """
    if len(paths) < 2:
        raise ValueError("Need at least 2 images to rank (chain)")

    score_fn = MODES.get(mode)
    if score_fn is None:
        available = sorted(MODES.keys())
        raise ValueError(
            f"Unknown sort_mode {mode!r}. Available: {', '.join(available)}"
        )

    resolved: list[Path] = []
    seen: set[Path] = set()
    for p in paths:
        rp = Path(p).expanduser().resolve()
        if rp in seen:
            continue
        if not rp.is_file():
            log.warning("Skipping unreadable target (chain): %s", rp)
            continue
        seen.add(rp)
        resolved.append(rp)

    if len(resolved) < 2:
        raise ValueError("Need at least 2 readable images to rank (chain)")

    chain: list[RankedItem] = [
        RankedItem(path=resolved[0], score=0.0, rank=0),
    ]
    remaining: set[Path] = set(resolved[1:])

    prefer_max = order == "farthest_first"

    while remaining:
        current = chain[-1].path
        best_path: Path | None = None
        best_score: float = -1.0 if prefer_max else float("inf")

        for r in sorted(remaining, key=str):
            try:
                s = score_fn(current, r)
            except Exception:
                log.warning("Skipping unreadable target during chain scoring: %s", r)
                continue

            if prefer_max:
                if best_path is None or s > best_score:
                    best_path = r
                    best_score = s
            else:
                if best_path is None or s < best_score:
                    best_path = r
                    best_score = s

        if best_path is None:
            log.warning("Chain: could not find next step; stopping early with %d remaining", len(remaining))
            break

        chain.append(RankedItem(path=best_path, score=best_score, rank=len(chain) - 1))
        remaining.discard(best_path)

    return chain


def rank_images_full(
    paths: list[str | Path],
    mode: str = "phash",
    order: SortOrder = "nearest_first",
    strategy: SortStrategy = "radial",
) -> RankResult:
    """Rank targets vs paths[0] (radial) or greedy walk (chain); return structured result for UI rank endpoint."""
    if len(paths) < 2:
        raise ValueError("Need at least 2 images to rank")

    base = str(Path(paths[0]).expanduser().resolve())

    if strategy == "chain":
        ranked = rank_images_chain(paths, mode=mode, order=order)
    else:
        targets = [str(Path(p).expanduser().resolve()) for p in paths[1:]]
        ranked = rank_images(base, targets, mode=mode, order=order)

    items: list[dict] = [
        {"path": base, "score": None, "role": "base"},
    ]
    for item in ranked[1:] if strategy == "chain" else ranked:
        items.append({
            "path": str(item.path),
            "score": round(item.score, 2),
            "role": "target",
        })

    ordered_paths = [base]
    if strategy == "chain":
        ordered_paths += [str(item.path) for item in ranked[1:]]
    else:
        ordered_paths += [str(item.path) for item in ranked]

    return RankResult(
        ordered_paths=ordered_paths,
        items=items,
    )
