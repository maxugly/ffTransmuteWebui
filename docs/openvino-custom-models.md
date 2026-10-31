# Custom Hugging Face OpenVINO models

Use a complete OpenVINO IR export of a supported architecture. Safetensors and GGUF are not direct substitutes for the files used by this tab. No model conversion was needed for the two Heretic exports tested here.

## Verified on this machine

- [Qwen3-4B-Instruct-2507 Heretic INT4](https://huggingface.co/machine-made-Fibre/Qwen3-4B-Instruct-2507-heretic-OpenVINO-INT4-NPU), revision `83133fb59fded8e181299ebfa31f6cc3136cca49`: GPU reload 5.02s; streamed exact reply, non-streamed arithmetic and generated Python all passed (about 0.8–2.5s per reply).
- [Qwen3-8B Heretic INT4](https://huggingface.co/machine-made-Fibre/qwen3-8b-heretic-OpenVINO-INT4-NPU), revision `3d7bd2571f8765e4b208e5a4887e7bbcec736330`: GPU reload 6.20s; the same three tests passed (about 1.1–2.8s per reply).

Both also passed real WebUI model selection → Apply → Load → Send Test and native structured `lookup_temperature(city="Paris")` calls. These reload timings include an existing compilation cache; first preparation can take longer. Despite the NPU labels, both were actually verified on **GPU**.

### Memory threshold

The first 8B attempt crossed the 8G soft limit and its cgroup recorded 107388 `high` events, with zero hard-limit or OOM events. It was interrupted before inference. The successful isolated tests used **MemoryHigh=9G and MemoryMax=9G**, avoiding the lower soft-throttling boundary while retaining the same hard cap. This global soft threshold was left at 9G; the previous settings are backed up privately in the proof folder. This observation diagnoses this attempt, not every earlier slow Cline request.

## Repeatable method

1. Download the entire repository with `huggingface_hub.snapshot_download` with a pinned `revision`, including XML/BIN model, tokenizer and detokenizer pairs, configuration, and chat template. Record the repository revision. Keep downloaded weights under `mtapi-project/junk/` per workspace policy.
2. Choose the export from the merged Model dropdown and download it. Repository identity and its absolute local directory are assigned automatically; existing configured entries retain their IDs and paths. For an export not discovered by the current bounded scan, an administrator can still register a local directory through the configuration API.
3. Use the installed Playground engine, **GPU**, KV precision **u4**, dynamic KV allocation (`KV GB = 0`), prefix caching and dynamic split fuse enabled. The tested initial client context budget is **8192**, output cap **512**, fallback output **128**. These are conservative test settings, not measurements of maximum supported context.
4. Apply, Load Model, and wait for actual loading to finish. An NPU-labelled export can be GPU-compatible; its label alone does not establish this. These cases must be verified on the selected device.
5. Send Test and require actual answer text plus stream completion. Then test non-streamed replies, a small coding task and structured tool calls. HTTP 200 or successful weight loading alone is insufficient.
6. Keep one model resident at a time. Stop & release GPU between cases. Retain the previous selection and tuning so they can be restored after testing.

For custom models, thinking controls are discovered from an `enable_thinking` conditional in the exported chat template (standalone `chat_template.jinja`, with `tokenizer_config.json` fallback). A model name or reasoning flag alone does not enable that control. Explicit client template settings still take precedence.

## Proof artifacts

The download, API and real-control browser scripts are in `mtapi-project/junk/hf-model-proof/`: `download.py`, `prove.py`, `ui-proof.cjs`. Model revisions are in `*.source.json`; output/timing evidence is in `results.json` and `ui-results.json`. The scripts are task proof artifacts, not a general installer; their execution switches active models and stops the API.

Validation scope: loading and short inference on this machine. This does not establish long Cline-context performance, reliable agent behavior, or the quality of abliteration.

## Built-in HF discovery (2026-10-24)

The single Model dropdown now merges Playground, configured entries and inspected HF exports. **Refresh models** forces a scan; the app also checks freshness at startup, hourly while visible and when brought back into view. HF is queried only after the cache is over 24 hours old (or a manual refresh), with a five-minute backoff after a failed automatic attempt. Offline scans retain the last successful list. Discovery uses bounded popular/recent OpenVINO searches plus Qwen/Llama/Phi and Heretic/abliterated searches; it is not an exhaustive index of HF.

Only complete text-generation IR exports with model/tokenizer/detokenizer pairs, configuration and a chat template are accepted. Metadata inspection does not download weights. Standard HF authentication (`HF_TOKEN` or cached HF login) stays server-side; no credential is imported into the repository or returned in discovery responses.

The default list shows conservative **Likely fits · untested** candidates. **Show experimental** includes uncertain architecture compatibility, missing estimate inputs and tight/oversized memory estimates. Fit uses actual weight bytes × 1.3, 1 GiB runtime overhead and a u4 KV estimate for up to 8192 tokens. The budget is the smaller of the hard cage limit and total RAM minus 4 GiB for the rest of the machine, with a further 10% safety margin. The GPU architecture allowlist is conservative; all fit labels are estimates, not load guarantees.

**Download** fetches only required IR/tokenizer/configuration artifacts at a fixed commit, with file/byte progress and **Cancel download**. Retrying resumes the pending commit even if discovery has since found a newer revision. Completion requires every expected file and size. New folders are under `mtapi-project/junk/hf-openvino-models/` with collision-resistant repository identities. Existing paths, model IDs and preset identities are preserved. Existing HF downloads can be recognized when their cached per-file commit metadata and sizes agree; recognition alone never marks them verified.

Discovery and downloads do not alter the resident model or settings. Browsing an undownloaded candidate does not add it to Cline when another model is applied. Changing the active model with **Apply** leaves it cold; **Load model** is a separate action. Same-model generation updates retain their earlier warm behavior.

**Verified here** requires a completed nonempty answer, including the terminal SSE marker for streamed requests. Empty, reasoning-only, tool-only and incomplete streams do not earn this catalog label. The record includes commit, device, runtime settings, model defaults and request generation overrides. Changing the revision, relevant settings/device or artifact timestamps invalidates it. Updating the discovery list never overwrites installed weights; newer revisions are noted while the installed revision remains pinned.

API additions: `POST /api/openvino/models/refresh` (`force: true` for manual refresh), `POST /api/openvino/models/download/cancel`. Existing catalog responses now include refresh/cache state and source, revision, size, suitability and verification fields. Model downloads still use the existing download endpoint and job-control progress/cancellation. Operational errors retain HTTP 200 with `ok: false`.

### Full workflow proof

Two exports discovered by the live scan completed Download → Apply → Load → streamed answer on Intel GPU:

- `durgasai299792458/Qwen3-0.6B-heretic-abliterated-int4`: 6.29s reload; returned an answer containing `42` in 1.30s.
- `OpenVINO/Qwen3-1.7B-int4-ov`: 19.48s preparation/load; returned `42` in 0.94s.

Proof folder: `mtapi-project/junk/hf-discovery-proof/`. `download-proof.log` records live cancellation/resume and unchanged resident PID through both downloads. `load-proof.log` and `results.json` record both completed cases. `release-check.log` covers background refresh outside this tab, restoration of the original 8B model, retained verification and narrow layout. `draft-check.log` proves undownloaded browsing does not leak into client discovery. This establishes short inference and the download workflow, not long Cline-context performance or model quality.
