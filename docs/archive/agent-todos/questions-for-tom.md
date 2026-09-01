# Questions for Tom

After auditing the 40+ specs against the codebase, I found that only ~8 operations have actual backend code (`*_ops.py`) and UI tabs. The remaining ~30 specs (e.g., VQGAN, FacereStore, SwinIR, AudioWave) have absolutely zero code implementation.

## 1. Backlog Organization
Should we move the 30 unimplemented idea specs into a `docs/backlog/` or `docs/ideas/` directory? Currently, they clutter the root `docs/` folder alongside active architectural specs.

## 2. In-Progress Features
I see `speedramp_ops.py` exists, but `speed-ramp-spec.md` is mostly empty. `AGENTS.md` says speed ramp is "in progress". Should I reverse-engineer the existing code and formalize the spec for it, or is someone else actively working on it?

## 3. Prioritization
If we are keeping all these specs in the active directory, which ones are slated for the immediate next phase? Do we have a roadmap, or are these just "ideas for later"?