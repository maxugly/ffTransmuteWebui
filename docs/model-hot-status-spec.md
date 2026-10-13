# Shared model heat and activity status — as built

The compact top-right **Models hot** button is available across the WebUI,
including tabs that hide the operation header. On retains supported models after
use; it does not eagerly load every installed model. Off releases retained
models once all registered active jobs finish. It never cancels generation or
audio playback. The pressed state, resident engine count and hover help reflect
server state. The preference persists in the existing settings file and Settings
uses the same switch. Earlier per-tab warm switches are replaced by this policy.

## Runtime coverage

- TTS Piper, Kokoro, Supertonic and Kitten: one isolated resident worker holds
  the last checkpoint. Repeated synthesis and voice changes reuse it where the
  model files are shared. A different checkpoint replaces the worker; a successful
  model installation invalidates it. Cold mode retains the original one-shot
  subprocess. Both launch through `shell.run_command` with argv lists.
- DeepDream TF/OpenVINO, Style Transfer TF/OpenVINO, FastSAM, Demucs/Stems and
  LaMa/Erase: the registered operation lifecycle retains their existing in-process
  model/compiled caches when On and clears loaded caches at idle when Off.
  FastSAM pipeline stages also honor the policy. Toggle cleanup never imports
  an unused neural library. Framework runtime allocations can outlive model objects.
- DECtalk is a small native command. Music, Txt2Img, Img2Img and external CLI
  engines remain one-shot; they need resident adapters and are listed explicitly
  in the button help. The toggle does not claim to retain those workers.

The TTS worker communicates through atomically written request/result files in
`mtapi-project/junk/model-hot/`. Async polling keeps the API responsive. Workers
exit on a stop file or loss of their API parent; idle shutdown closes the worker.
The manager defers release while jobs are active. Subprocess failures become
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

`GET/POST /api/models/hot` returns policy, resident engines and deferred release.
POST accepts a Boolean `enabled`; operational failures use HTTP 200 + `ok:false`.
`GET /api/activity` supplies current/recent progress and TTS timing estimates.

Gate 5/5. Targeted TTS/settings/native-cache suite: 176 passed; the additional
shared-operation policy test passes with the six heat/history tests. Real
Playwright controls prove cold timing, repeated Piper synthesis with unchanged
worker PID and exactly one load, learned ETA/elapsed/word count, Off during a
job finishing before release, cross-tab toggle and reload persistence. Selected
text/DECtalk playback regression passes. Additional real Kokoro, Supertonic and
Kitten generations change voices while preserving the same PID and one model
load. Active screenshot inspected.
