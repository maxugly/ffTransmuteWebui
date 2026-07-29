const POOL_LAYOUT_DEFAULTS = {
  composeHeight: 280,
  focusWidth: 340,
  selectionHeight: 0, // 0 = auto (aspect-ratio 32/9 for dual frames)
  matchHeight: 180,
  collapsed: { sequence: false, selection: false, matches: false },
};

const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.mpg', '.wmv', '.flv', '.ts', '.mts', '.m2ts'];

/** Tile overlay fields (checkbox menu). order = menu + render order. */
const TILE_INFO_FIELDS = [
  { key: 'name', label: 'File name' },
  { key: 'path', label: 'Full path' },
  { key: 'hash', label: 'Content hash' },
  { key: 'opens', label: 'Open / history counts' },
  { key: 'duration', label: 'Duration' },
  { key: 'fps', label: 'Frame rate' },
  { key: 'frames', label: 'Frame count' },
  { key: 'video_codec', label: 'Video codec' },
  { key: 'audio_codec', label: 'Audio codec' },
  { key: 'size', label: 'File size' },
  { key: 'dims', label: 'Resolution' },
  { key: 'frame_labels', label: 'FIRST / LAST labels' },
];

const POOL_ZOOM = {
  min: 100,
  max: 440,
  reset: 200, // matches original card density
  step: 28,
};

export { POOL_LAYOUT_DEFAULTS, VIDEO_EXTS, TILE_INFO_FIELDS, POOL_ZOOM };
