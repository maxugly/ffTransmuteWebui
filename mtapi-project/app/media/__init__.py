"""
Media package facade.

Public API for the media subsystem — routes and main.py import from here.
Implementation lives in config, cache, thumbnails, open, pool, match, and projects.
"""
from .config import (  # noqa: F401
    BY_HASH_DIR,
    FRAME_EXTRACT_VERSION,
    HASH_ALGO,
    HASH_CHUNK,
    HASH_DIGEST_SIZE,
    INDEX_PATH,
    MEDIA_ROOT,
    POOL_STATE_PATH,
    _ensure_dirs,
    _extract_ver_path,
    _frames_dir,
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
    existing_thumb_file,
    THUMBNAIL_SIZES,
    normalize_thumb_size,
)
from .cache import (  # noqa: F401
    BATCH_PATH_LIMIT,
    _empty_record,
    _load_index,
    _lock_for_hash,
    _remember_path,
    _save_index,
    _update_index_entry,
    append_history,
    find_existing_paths_for_hash,
    source_path_for_hash,
    gc_lower_density_rifed,
    get_variants,
    hash_file,
    load_record,
    lookup_cached_hash,
    media_cache_stats,
    parse_batch_paths,
    record_operation,
    recover_media_path,
    register_variant,
    resolve_hash,
    save_record,
    stat_signature,
)
from .thumbnails import (  # noqa: F401
    _compute_phash_hex,
    _last_frame_ffmpeg_cmds,
    ensure_phashes,
    ensure_thumbs,
    export_frame_png,
    extract_frame,
    extract_frame_at,
    get_frame_thumb_file,
    get_thumb_file,
    hamming_distance_hex,
    load_phash,
    save_phash,
)
from .open import (  # noqa: F401
    _public_payload,
    open_media,
)
from .pool import (  # noqa: F401
    DESK_TAB_DEFAULTS,
    POOL_SCHEMA_VERSION,
    _default_pool_state,
    _normalize_media_entries,
    _normalize_pool_payload,
    load_pool_state,
    save_pool_state,
)
from .match import (  # noqa: F401
    match_frames,
)
from .projects import (  # noqa: F401
    LAST_PROJECT_PATH,
    PROJECT_KIND,
    PROJECT_VERSION,
    _ensure_project_ext,
    get_last_project_path,
    load_project_file,
    save_project_file,
)
from .performance import (  # noqa: F401
    DEFAULT_SETTINGS,
    SETTINGS_PATH,
    load_settings,
    save_settings,
    thumbnail_cache,
    phash_cache,
)
from .catalog import (  # noqa: F401
    THUMB_RAM_BUDGET,
    CatalogIndex,
    CatalogLockHeld,
    catalog_if_ready,
    get_catalog,
)
