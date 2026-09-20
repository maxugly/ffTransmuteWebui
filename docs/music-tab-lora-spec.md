# Music Tab — LoRA Fine-Tuning (spec sheet, vNext)

> **Status:** Specification, early (open questions marked **[?]** — answers needed before build)
> **Date:** 2026-09-18
> **Parent:** `music-tab-spec.md` (conventions, honesty rules, proof gates inherit)
> **Trigger:** base model live in tab (`8.081`); user workflow = sample own clips, train
> own aesthetic, generate in that aesthetic.

## 1. What LoRA means here

Low-Rank Adaptation: freeze the 2B base/turbo weights, train small rank-decomposition
matrices on the user's own clips, then merge (or side-load) at inference. Target:
the user's chopped-up Wu-Tang-adjacent aesthetic as a selectable tab entry
(e.g. `acestep-v15-base + wutang-v1`).

## 2. Open questions (research spike first, no code until answered)

| # | Question | Why it blocks |
|---|---|---|
| 1 | What does upstream ACE-Step 1.5 support? (training scripts? Diffusers PEFT LoRA? which modules — DiT attention? text projector? condition encoder?) | Determines everything downstream |
| 2 | Can LoRA *training* run on this box? (16 GB RAM, Iris Xe — no CUDA; iGPU training unsupported; CPU AdamW on 2B + rank-N adapters = hours-to-days per epoch?) | If no, training happens elsewhere and the tab only *imports* finished LoRAs |
| 3 | Data format: what does training consume? (clips + captions? how many minutes? preprocess = our own VAE latents?) | Defines the dataset-prep UI (likely: pool clips → caption → export pack) |
| 4 | Merge vs side-load at OV inference? (merged = new safetensors → re-export IR per LoRA, 45+ min each; side-load = separate MatMuls — does OV even support PEFT adapters?) | Decides the whole runtime design |
| 5 | License/cleanliness: training on user's own chopped clips of *their* generations = clean; chopped commercial records = user's responsibility (tab states this, no enforcement theater) | Copy honesty, one line |

## 3. Shape of the feature (once questions resolve)

- **Dataset tab section:** pick pool clips → auto-caption (prompt reuse) → export training pack. No training UI until Q2 answers.
- **Import path first:** finished LoRA (safetensors adapters) → merge → re-export IR → new dropdown entry with source-LoRA noted. Import-first means the tab works even if training never runs on this box.
- **Training path (only if Q2 says feasible):** queued job, progress per epoch, checkpoints as artifacts, cancel-safe. Never in the server process (same OOM rule as generation).
- **Knob:** LoRA select (none + installed LoRAs) + strength slider — appears only for entries that have LoRAs (honesty rule).

## 4. Non-goals

- Full fine-tunes (only adapters).
- Training Stable Audio variants (separate sheet if SA3 lands).
- Automatic quality judging of LoRAs (ears, as always).

## 5. Acceptance (same gate as parent spec +)

1. Research spike answers Q1–Q5 in writing (links + measured numbers, not hopes).
2. Import path: LoRA in → merged IR → tab entry → ear-verified clip in that aesthetic.
3. Training path (if feasible): pack out → adapters back → same as (2).
4. VERSION bump + STATUS row, full suite green.
