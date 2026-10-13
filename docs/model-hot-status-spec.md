# Per-tool model retention and global residency — as built

Each model-loading tool has a status strip at the top of its form. **Keep loaded**
is a separate server-persisted preference for each supported tool; it takes effect
after a real run. Navigation and status polling never load or release models.
There is no global retention toggle in the header or Settings. Existing explicit
per-tool preferences survive; the old global preference is ignored, not copied
into every tool. The three older warm knobs are replaced by the same per-tool strip.

The global indicator remains visible on every tab, including bare workspaces:
- **Orange:** nothing loaded and nothing loading.
- **Red:** models loaded elsewhere, none for the current tab.
- **Green:** a model loaded for this tab (other models may also be resident).
- **Yellow:** any model is loading; loading takes priority over residency.
- **Gray:** status unavailable, rather than falsely reporting no resident models.

The local strip shows this tool's load state, loaded model names, selected model
and its measured weight/artifact size **on disk**. Disk bytes are not RAM/VRAM
estimates. Hugging Face symlinks and hardlinked files are counted once. Missing
weights say size unavailable. Selection reads do not download models or import a
neural runtime. Recoherence includes its selected RIFE and diffusion artifacts;
ACE-Step sizes include shared encoders/decoder and the selected LoRA IR when used.

Off releases only this tool's cached objects. Release waits until registered jobs
are idle, protecting shared pipeline users; it never cancels computation or audio
playback. Turning off one tool never releases another tool's retained model.

## Runtime coverage

- TTS Piper, Kokoro, Supertonic and Kitten: one isolated resident worker holds
  the last checkpoint. Repeated synthesis and voice changes reuse it where the
  model files are shared. A different checkpoint replaces the worker; a successful
  model installation invalidates it. Cold mode retains the original one-shot
  subprocess. Both launch through `shell.run_command` with argv lists.
- DeepDream TF/OpenVINO (including V2/V3), Style Transfer TF/OpenVINO, FastSAM,
  Demucs/Stems, LaMa/Erase and local WithoutBG: the registered operation lifecycle retains their existing in-process
  model/compiled caches when On and clears loaded caches at idle when Off.
  FastSAM pipeline stages also honor their own tool preference. Toggle cleanup never imports
  an unused neural library. Framework runtime allocations can outlive model objects.
- DECtalk is a small native command. Music, Txt2Img, Img2Img and external CLI
  engines remain one-shot; they need resident adapters and are listed explicitly
  on their own status strips. They show a disabled retention control with an explicit
  explanation, actual loading/residency telemetry and selected artifact size.

The TTS worker communicates through atomically written request/result files in
`mtapi-project/junk/model-hot/`. Async polling keeps the API responsive. Workers
exit on a stop file or loss of their API parent; idle shutdown closes the worker.
The manager defers release while jobs are active. Worker responses report actual
loaded state even if inference fails after loading. Subprocess failures become
ordinary failed TTS jobs, preserving the earlier audio preview.

## Bottom-left activity

The sidebar status box shows the current job/engine, phase, elapsed duration,
word count for TTS, and an approximate ETA when available. TTS workers report
Loading model and Synthesizing speech; export reports conversion. Generic jobs
use the existing progress ETA. Without an estimate elapsed time keeps ticking.
Idle status includes the latest operation’s outcome and total elapsed time.

TTS stores bounded timing history beside the existing settings file
(`tts-timings.json`). The profile key includes pinned revision, voice, quality
and validated synthesis controls. Each sample records word count, observed
setup/load time, inference time and export time, plus actual cache reuse. ETA is
mean cold load cost (zero for a reused model) + observed inference seconds per
word × requested words + mean export cost. Missing cold observations do not
produce a cold ETA. Estimates are approximate; overruns say Taking longer than
estimated instead of a negative countdown. Failed jobs do not train the history.
Only timings/counts are retained, not scripts. Corrupt entries are ignored and
persistence failure cannot fail a completed synthesis.

## Interfaces and proof

`GET /api/models/hot` returns per-tool `policies`, tab capability metadata,
`resident`, `loading`, active-job count and the tool names awaiting deferred
release. Optional `tab`, `model`, `engine`, `voice`, `quality`, `auxiliary` and
`lora` query fields return the selected artifacts' disk size. `POST` requires
`tool` and Boolean `enabled`; global-only requests and unsupported retention
requests fail with HTTP 200 + `ok:false`. `GET /api/activity` supplies existing
current/recent progress and TTS timing estimates.

Native loaders report loading only on cache misses. FastSAM export and lazy
OpenVINO predictor initialization run off the API event loop, with serialized
engine access so polling remains responsive and concurrent calls do not race. SD/QR workers emit an
explicit loaded marker after pipeline loading. ACE-Step inference output confirms
loaded state. NCNN output frames confirm active residency; process exit removes
it. Face-morph's upstream predictor has no load-complete signal, so its bounded
landmark call shows loading/detecting rather than claiming precise residency.
Temporary model observations are removed on failure, process exit or job finish.
Caches and live TTS worker metadata supply idle retained-model state.

Proof: gate 5/5; targeted model lifecycle, TTS, native-cache and RIFE tests.
Real Playwright clicks prove orange/yellow/green/red states with a real Piper
worker, independent TTS/DeepDream preferences, actual selected disk size,
retained worker PID across model tabs, unrelated-toggle isolation, scoped release,
reload persistence and no model-policy/generation POSTs from tab navigation.
Screenshots in `mtapi-project/junk/model-tab-green.png` and `model-tab-red.png`.
