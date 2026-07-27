# TODO

> Pick one. Do it. Check it off. Next.

## now
- [x] PNG pipeline: facemorph_engine (ffmpeg tangled with dlib landmarks) ✅
- [ ] PNG pipeline: deepdream_engine (1127 lines — gradient ascent, temporal blend, ouroboros)

## next
- [x] Static routes: extract 3 file-serving endpoints from main.py → app/routes/static.py ✅
- [x] Global inputs bar: finish 4-input UI (video, image, path in, path out) ✅
- [ ] Global inputs: multi-file sequential processing (withoutbg, facemorph, styletransfer)
- [ ] Global inputs: status indicators (✅ ❌ ✔️) and styletransfer banner
- [ ] Global inputs: Path in directory scanning, Path out output override
- [ ] Global inputs: file existence verification before processing
- [ ] Global inputs: stop between iterations
- [ ] main.py route split: 19 endpoints → app/routes/*.py
- [ ] media_store.py split: 1324 lines → app/media/*.py

## someday
- [ ] Speed ramp end-to-end (M4)
- [ ] QA review pass (M5)
- [ ] Rubberband audio v2 (M6)
- [ ] Delete app.js.bak and old style.css (dead code cleanup)
