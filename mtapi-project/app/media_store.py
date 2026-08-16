"""
Backward-compatible shim. All implementation has moved to app/media/ sub-modules.

Import from app.media (the facade) instead of app.media_store — this module
exists only so existing imports outside the app package continue to resolve.
"""
from __future__ import annotations

import logging

log = logging.getLogger("mtapi.media_store")

# Shared paths, constants, locks
from app.media.config import (  # noqa: E402, F401
    _ensure_dirs,
    _extract_ver_path,
    _hash_dir,
    _hash_locks,
    _hash_locks_guard,
    _index_lock,
    _invalidate_stale_last_thumb,
    _mark_extract_version,
    _path_key,
    _phash_path,
    _record_path,
    _thumb_is_current,
    _thumb_path,
    BY_HASH_DIR,
    FRAME_EXTRACT_VERSION,
    HASH_ALGO,
    HASH_CHUNK,
    HASH_DIGEST_SIZE,
    INDEX_PATH,
    MEDIA_ROOT,
    POOL_STATE_PATH,
)

# Cache layer
from app.media.cache import (  # noqa: E402, F401
    _empty_record,
    _load_index,
    _lock_for_hash,
    _remember_path,
    _save_index,
    _update_index_entry,
    append_history,
    hash_file,
    load_record,
    lookup_cached_hash,
    media_cache_stats,
    record_operation,
    resolve_hash,
    save_record,
)

# Thumbnails & frame export
from app.media.thumbnails import (  # noqa: E402, F401
    _compute_phash_hex,
    _last_frame_ffmpeg_cmds,
    ensure_phashes,
    ensure_thumbs,
    ensure_wall_pair,
    ensure_wall_preview,
    ensure_wall_previews,
    export_frame_png,
    extract_frame,
    get_thumb_file,
    hamming_distance_hex,
    load_phash,
    save_phash,
)

# Open/orchestration
from app.media.open import (  # noqa: E402, F401
    _public_payload,
    open_media,
)

# Matching
from app.media.match import (  # noqa: E402, F401
    match_frames,
)

# Pool state
from app.media.pool import (  # noqa: E402, F401
    _default_pool_state,
    _normalize_pool_payload,
    load_pool_state,
    save_pool_state,
)

# Projects
from app.media.projects import (  # noqa: E402, F401
    _ensure_project_ext,
    get_last_project_path,
    LAST_PROJECT_PATH,
    load_project_file,
    PROJECT_KIND,
    PROJECT_VERSION,
    save_project_file,
)
