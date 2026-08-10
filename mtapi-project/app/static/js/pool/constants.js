const POOL_LAYOUT_DEFAULTS = {
  composeHeight: 280,
  focusWidth: 340,
  selectionHeight: 0, // 0 = auto (aspect-ratio 32/9 for dual frames)
  matchHeight: 180,
  collapsed: { sequence: false, selection: false, matches: false, pool: false },
};

const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.mpg', '.wmv', '.flv', '.ts', '.mts', '.m2ts'];

/** Still-image extensions for Image Pool (not video containers). */
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff', '.ppm', '.pgm'];

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

/** Sequence strip token size (levels applied as data-seq-w / data-seq-h). */
const SEQ_TOKEN_SIZE = {
  wMin: 0,
  wMax: 5,
  wDefault: 2, // ~148px min width — room for ORIG + badge
  hMin: 0,
  hMax: 5,
  hDefault: 2, // two-row layout, comfortable padding
};

export {
  POOL_LAYOUT_DEFAULTS, VIDEO_EXTS, IMAGE_EXTS, TILE_INFO_FIELDS, POOL_ZOOM, SEQ_TOKEN_SIZE,
};
