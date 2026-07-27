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
- [x] main.py route split: /api/browse → routes/browse.py
- [x] main.py route split: media routes → routes/media.py (8 endpoints)
- [x] main.py route split: /api/picker → routes/picker.py (180 lines)

## next
- [ ] Global inputs: status indicators (✅ ❌ ✔️) and styletransfer banner
- [ ] Global inputs: Path in directory scanning, Path out output override
- [ ] Global inputs: file existence verification before processing
- [ ] Global inputs: stop between iterations
- [ ] main.py route split: pool routes (state, save, load, last, match, scan)
- [ ] main.py route split: watcher, jobs, health
- [ ] media_store.py split: 1324 lines → app/media/*.py
- [ ] Review agy's civitai-spec.md

## someday
- [ ] Speed ramp end-to-end (M4)
- [ ] QA review pass (M5)
- [ ] Rubberband audio v2 (M6)
- [ ] Delete app.js.bak and old style.css (dead code cleanup)
