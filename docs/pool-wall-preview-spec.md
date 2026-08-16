# Pool wall preview — as-built `000.000.6.7`

> **Status:** Implemented  
> **Purpose:** One small static preview per clip on Video / Image Pool. Prepared up front. Never a match/pHash source.

## Product

On import / open we extract **first and last**, then write two display JPEGs:

| File | What |
|------|------|
| `wall_pair.jpg` | First \| last side by side, 120px per half (default wall) |
| `wall.jpg` | First frame only, 120px (the 6.6 extra) |

Settings → Pool & cache → **First + last wall** (on by default). Off shows `wall.jpg`.

Match / pHash still use the separate first/last H thumbs. Sequence and Cut still use those.

Scrolling does not load, unload, or clear the wall `<img>`.

## Files

| Path | Role |
|------|------|
| `by_hash/<hash>/wall_pair.jpg` | Combo display JPEG |
| `by_hash/<hash>/wall.jpg` | Single first-frame display JPEG |
| `ensure_wall_previews` | Writes both from existing first/last (or extracts them on import) |
| `GET /api/thumbnail?which=wall_pair` / `which=wall` | Serve the chosen file |
| `static/js/pool/wall-thumbs.js` | Stable `<img>` per path; chrome is recycled |

## Rules

1. Extract first+last on import, then compose the wall files. Do not decode video on ordinary display GET.
2. Assign `src` once per style. Style change may swap `which=` on the same tenant.
3. Never clear `src` because a shell was reused.
4. Do not feed wall JPEGs to pHash / Find matches.

## Out of scope

- Sequence tokens, Cut range thumbs, clip-info first/last
- Deleting the L/M/H setting (match-size first/last)
- Replacing JPEG with WebP
