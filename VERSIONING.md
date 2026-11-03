# Versioning (humble, never-rush-to-1.0)

Format: **`AAA.BBB.CCC.DD`** (zero-padded, four parts)

| Part | Meaning |
|------|---------|
| **AAA** | Epoch / tectonic product shifts. Stay at `000` for a long time. |
| **BBB** | Large feature *areas* only. Still `000` while the product is exploratory. |
| **CCC** | Minor releases — the usual bump when something shippable lands. |
| **DD**  | Patch / hotfix within a minor (`00`, `01`, …). |

Philosophy: conservative and slightly self-deprecating. Hitting `1.0.0.00` (or even `001.000.0.00`) should feel *wrong* for years. Prefer shipping many quiet `000.000.x.yy` points.

Source of truth: root `VERSION` (single line). FastAPI `app.version` reads it at import.

## History

| Version | Notes |
|---------|--------|
| `000.000.2.00` | Folder Watcher tab + API; stop relying on systemd transcode daemon for UI control. |
| `000.000.8.195` | Vectorize in-app polish; single-app lifecycle hardening (reuse-or-reap embedded server, kill on exit, single instance); deduplicated ES module URLs (fixed double file picker); removed dead in-app file-browser modal and /api/browse; /vectorize/svg localhost-only. |
| *(pre-version)* | Unnumbered mainline until this scheme. |
