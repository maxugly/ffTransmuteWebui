# TODO

> Pick one. Do it. Check it off. Next.

## now
- [x] PNG pipeline: rife_ops + speedramp_png ✅
- [x] PNG pipeline: facemorph_engine ✅
- [x] PNG pipeline: deepdream_engine ✅
- [ ] main.py route split: /api/browse → app/routes/browse.py (codewhale working on this)

## next
- [x] Static routes: extract 3 file-serving endpoints from main.py ✅
- [x] Global inputs bar: finish 4-input UI ✅
- [ ] Global inputs: multi-file sequential processing (withoutbg, facemorph, styletransfer)
- [ ] Global inputs: status indicators (✅ ❌ ✔️) and styletransfer banner
- [ ] Global inputs: Path in directory scanning, Path out output override
- [ ] Global inputs: file existence verification before processing
- [ ] Global inputs: stop between iterations
- [ ] main.py route split: media routes (video, image, probe, media_info, thumbnail, export_frame)
- [ ] main.py route split: pool routes (state, save, load, last, match, scan)
- [ ] main.py route split: picker (178 lines of kdialog/zenity/tkinter)
- [ ] main.py route split: watcher, jobs, health
- [ ] media_store.py split: 1324 lines → app/media/*.py
- [ ] Review agy's civitai-spec.md

## someday
- [ ] Speed ramp end-to-end (M4)
- [ ] QA review pass (M5)
- [ ] Rubberband audio v2 (M6)
- [ ] Delete app.js.bak and old style.css (dead code cleanup)
