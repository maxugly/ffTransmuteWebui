import os
import re
import glob
import json

shared_defaults = {
  "datamosh": { "moshTail": "10" },
  "deepdream": {
    "dreamStep": "0.01",
    "dreamIters": "20",
    "dreamOctaves": "3",
    "dreamOctScale": "1.4",
    "dreamMaxLoss": "-1",
    "dreamBlend": "1.0",
    "dreamStepTo": "0.01",
    "dreamItersTo": "20",
    "dreamOctavesTo": "3",
    "dreamOctScaleTo": "1.4",
    "dreamMaxLossTo": "-1",
    "dreamBlendTo": "1.0",
    "dreamFrameStep": "1",
    "dreamMaxFrames": "-1",
    "dreamTemporalBlend": "0.85",
    "dreamPreviewW": "640",
    "dreamOuroLen": "30",
    "dreamOuroFps": "30",
    "dreamZoom": "1.04",
    "dreamSpin": "1.5",
    "dreamTx": "5",
    "dreamTy": "5",
    "dreamEvolveFps": "12",
    "dreamEvolveThr": "4",
    "dreamEvolveCapN": "-1"
  },
  "facemorph": {
    "fmDuration": "2.0",
    "fmFps": "30",
    "fmCrf": "18",
    "fmAlignSize": "1024",
    "fmDreamPreview": "640"
  },
  "fastsam": {
    "fastsamTargetX": "0.5",
    "fastsamTargetY": "0.5",
    "fastsamConf": "0.4",
    "fastsamIou": "0.7"
  },
  "imagesort": { "isMultiplier": "2", "isFps": "24", "isCrf": "18" },
  "img2img": { "i2iStrength": "0.35", "i2iMaxSide": "-1" },
  "qr": { "qrStrength": "0.35", "qrCtrlScale": "1.1", "qrIpAdapterScale": "0.5" },
  "rife": { "rifeMultiplier": "2", "rifeTargetFps": "60" },
  "riferecohere": { "rrStrength": "0.55", "rrFps": "24", "rrMaxSide": "-1", "rrSeed": "-1" },
  "settings": { "settingsThumbIndex": "0", "settingsAutosaveIndex": "0", "settingsScrollbarWidth": "8" },
  "speedchange": { "usSpeed": "1", "usLength": "10", "usFps": "-1" },
  "styletransfer": {
    "stStrength": "1.0",
    "stMaxSide": "1280",
    "stEvolveFrames": "16",
    "stEvolveStr0": "0.35",
    "stEvolveStr1": "1.0",
    "stEvolveFps": "12"
  },
  "transmute": {
    "transmuteQuality": "2",
    "transmuteSecondsFromEnd": "1.0",
    "transmuteWidth": "1920",
    "transmuteHeight": "1080",
    "rampDuration": "5.0",
    "rampStartSpeed": "4.0",
    "rampEndSpeed": "0.33",
    "rampRifeMult": "2",
    "cfrFps": "24",
    "cfrRifeMult": "2",
    "cfrTStep": "0.25",
    "zoomDuration": "3.0",
    "zoomFps": "24",
    "zoomFrameD": "1",
    "zoomRate": "0.02",
    "zoomCap": "3.0",
    "zoomPanX": "0",
    "zoomPanY": "0",
    "zoomWidth": "1024",
    "zoomHeight": "1024",
    "zoomOscAmp": "0",
    "zoomOscFreq": "10",
    "zoomRotate": "0",
    "zoomGlitch": "0",
    "zoomStretchX": "1.0",
    "zoomStretchY": "1.0",
    "zoomPunchFrame": "20",
    "zoomHueRate": "0"
  },
  "txt2img": { "t2iWidth": "1024", "t2iHeight": "1024", "t2iCount": "1" },
  "upscale": { "knobUpScale": "4", "knobUpTile": "512", "upNoiseVal": "0", "upGrainVal": "0" },
  "watermark": { "wmBitrate": "12" },
  "erase": { "erBrush": "24", "erTrigger": "800", "erMargin": "128", "erLimit": "1280" },
  "demucs": { "dmOverlap": "0.25", "dmTransPow": "1.0" },
  "music": { "muDuration": "30", "muBpm": "-1", "muSeed": "-1", "muShift": "3.0" }
}

tabs_dir = 'mtapi-project/app/static/js/tabs'

for tab, knobs in shared_defaults.items():
    file_path = f"{tabs_dir}/{tab}.js"
    if not os.path.exists(file_path):
        continue
        
    with open(file_path, 'r') as f:
        content = f.read()
        
    for knob_id, val in knobs.items():
        # Replace knobUnitHtml({ id: '...', ..., value: '...' })
        # Using a regex that matches the specific id and captures the value part to replace it
        pattern = r"(knobUnitHtml\(\s*\{[^\}]*?id\s*:\s*['\"]" + knob_id + r"['\"][^\}]*?value\s*:\s*(?:_saved\([^,]+,\s*)?)['\"][^'\"]+['\"]"
        # We need to replace the quoted value with our new val
        # Wait, if it has _saved('key', 'val'), we replace the 'val'
        
        def repl(m):
            # m.group(1) is everything up to the opening quote of the value
            return m.group(1) + f"'{val}'"
            
        content, n = re.subn(pattern, repl, content)
        if n > 0:
            print(f"Updated {knob_id} to {val} in {tab}.js")
            
    with open(file_path, 'w') as f:
        f.write(content)

