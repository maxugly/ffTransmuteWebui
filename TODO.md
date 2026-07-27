# TODO

> Pick one. Do it. Check it off. Next.

## done
- [x] PNG pipeline: rife_ops + speedramp_png
- [x] PNG pipeline: facemorph_engine
- [x] PNG pipeline: deepdream_engine
- [x] ffprobe consolidation → app/probe.py (7 callers migrated)
- [x] datamosh twins: bin/datamosh.sh deleted, shell.py → root
- [x] Static routes: extract 3 file-serving endpoints → routes/static.py
- [x] Global inputs bar: 4-input UI (video, image, pathIn, pathOut)
- [x] Global inputs: multi-file sequential processing (withoutbg, facemorph, styletransfer)
- [x] Global inputs: status indicators (✅ ❌ ✔️) and styletransfer banner
- [x] Global inputs: file existence verification before processing
- [x] Global inputs: Path in directory scanning (scan_input_dir)
- [x] Global inputs: Path out output override (context var → finalize_output_path)
- [x] Global inputs: stop between iterations (already present, verified)
- [x] main.py route split: /api/browse → routes/browse.py
- [x] main.py route split: media routes → routes/media.py (8 endpoints)
- [x] main.py route split: /api/picker → routes/picker.py (180 lines)
- [x] main.py route split: pool routes → routes/pool.py
- [x] main.py route split: watcher, jobs, health → routes/meta.py

## next
- [ ] media_store.py split: 1324 lines → app/media/*.py
- [ ] Review agy's civitai-spec.md

## someday
- [ ] Speed ramp end-to-end (M4)
- [ ] QA review pass (M5)
- [ ] Rubberband audio v2 (M6)
- [ ] Delete app.js.bak and old style.css (dead code cleanup)
