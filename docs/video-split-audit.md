# Video Split Build Audit (8.050)

> Every judgment call behind the 22 new columns. `Released` prose is byte-identical everywhere — where research disagrees, `Rel Date` carries the research value and the mismatch is listed in §A for the standing research to resolve.

## A. Rel Date vs Released-text conflicts (research value filed, prose kept)

| Row | Released text | Rel Date filed | Research refs |
|---|---|---|---|
| LTX 0.9.8 | 2026-06 | 2025-07 | HF Lightricks/LTX-Video, fal ltxv-13b-098 |
| LTX 2 Fast | 2026-01 | 2025-10 | ltx.io newsroom, Replicate ltx-2-fast |
| Wan 2.2 Fast | 2025-02 | 2025-07 | Wan-Video/Wan2.2, fal fast-wan |
| Wan 2.7 | 2026-05 | 2026-04 | Aliyun Model Studio, fal v2.7 |
| Wan 2.6 | 2026-03 | 2025-12 | Alibaba press, Vercel AI gateway |
| Kling 3.0 / O3 | 2026-01 | 2026-02 | kling.ai user guide, fal blog |
| Kling 3.0 Motion | 2026-02 | 2026-05 | fal.ai/kling-motion-control |
| Seedance 1.0 Lite | 2025-07 | 2025-06 | seed.bytedance.com, fal v1-lite |
| Seedance 1.0 Pro | 2025-10 | 2025-06 | seed.bytedance.com, fal v1-pro |
| Seedance 2.5 Lite | 2026-07 | 2026-08 | picassoia collection |
| Seedance 2.0 Mini | 2026-04 | 2026-06 | seed.bytedance.com 2.0 blog |
| PixVerse V4 | 2024-12 | 2025-02 | pixverse.ai, runware v4 |
| PixVerse V4.5 | 2025-04 | 2025-05 | pixverse.ai, runware v4-5 |
| PixVerse V5.6 | 2025-11 | 2026-01 | pixverse.ai, runware v5-6 |
| Runway Gen 4 | 2025-06 | 2025-03 | runwayml help, Replicate gen4-turbo |
| Runway Gen 4 Turbo | 2025-07 | 2025-04 | runwayml help, runware |
| Runway Act Two | 2026-01 | 2025-09 | runwayml help, aimlapi docs |
| Luma Ray2 | 2024-12 | 2025-01 | lumalabs.ai changelog, fal ray-2 |
| Luma Ray3 | 2025-11 | 2025-09 | lumalabs.ai/news/ray3 (3.14: 2026-01) |
| Veo 3 row | 2026-05 | 2025-05 | ai.google.dev/veo (3.1: 2025-10) |
| H3 Max Turbo | 2026-08 | 2026-09 | fal h3-max-turbo |
| Live Illustrations | 2025-02 | 2025-01 | minimax.io news, fal video-01-live |
| Happy Horse 1.1 | 2025-11 | 2026-06 | Aliyun help, fal happy-horse v1.1 |
| Happy Horse 1.0 | 2025-08 | 2026-04 | fal happyhorse-1.0, Replicate |
| Happy Horse Edit | 2025-12 | 2026-04 | Aliyun help, fal video-edit |
| Grok 1.5 | 2025-12 | 2026-06 | x.ai news, runwayml help |
| Grok base | 2025-08 | 2026-01 | docs.x.ai, venice.ai |
| Gemini 1.1 Flash | 2026-03 | 2026-08 | ai.google.dev/omni, morphic |
| Gemini Flash | 2025-11 | 2026-05 | deepmind model card, maxvideoai |
| Omni Human 1.5 | 2025-12 | 2025-08 | byteplus OmniHuman, fal v1.5 |
| Omni Video Custom | 2025-06 | 2026-02 | OmniCustom GH, HF Space |

## B. Prose-derived fills (research UNKNOWN — used existing row prose)

- LTX Upsampler: all numerics + tiers from row prose (research: all-UNKNOWN; research tiers all-N vs prose 4K claim — prose wins, tiers 720/1080/2K/4K Yes).
- LTX 2 TURBO native 1920x1080 (prose `720p-1080p` → max).
- Wan 2.2 rCM: all numerics + 480/720 Yes from prose; durMax 6.8 (extendable 109f).
- LTX F2LF tiers 480N (research) vs prose `range 480p-1440p` — research wins, flagged.
- Seedance 2.0 tiers 2K/4K forced **No** (research said Yes, but 4K arrives via platform SR = upscaler path per split rules; 2K unclaimed).
- LTX 2.3 Pro dur 6–10 (research) vs prose `20s`.
- Hunyuan dur 5/5 (research) vs prose `5-10s`.
- H3 Max Turbo dur 5–15 (existing prose; research: 5-15 unverified for Turbo).
- Veo sweet 2160 (final-over-default call on `720p default, 1080p or 4K for final`).
- Pyramid Flow tiers all-No despite 1280x768 (768p is not a standard tier).
- Real Motion 2.6 / 2.6 Remix: 720p tier left blank (research blank despite 1080p native).
- Van Gogh HQ: 720p/540p tiers left blank (no explicit sub-1080p claim).
- Real Motion 3.5 Turbo / 3.2 / 3.2 Remix, Van Gogh ×3, Gen-4S, Sora 2 Max: full numeric + tier fill from prose (research UNKNOWN).
- Grok base sweet 720p, Grok 1.5 sweet 1080p, Kling 01 sweet Pro figures: prose-derived.

## C. Landscape-assumed W fills (portrait variants documented in notes)

W filed from bare tier labels per the approved standards map while research notes portrait variants (recorded in Nat/Max Note): all PixVerse rows, Vidu rows, Wan 3.0/Prime/2.6/2.7, Happy Horse rows, Kling rows (W omitted — H-only — except Kling 01 explicit WxH), Grok 1.5, Luma rows (max omitted), FLUX 3 (1920, no portrait documented). Standing research (§8) confirms or corrects each.

## D. Fully-unknown survivals

- Omni Video Custom: all six tiers blank, natW/H blank (config buckets in Nat Note).
- Sora 2 Max, Play: partial (dur + fps only where known).
- Seedance 3.0 (folded in 2.5/3.0 row): all-UNKNOWN — row carries 2.5 values.
