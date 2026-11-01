"""Vectorize operations — orchestrator + engine runners."""
import os, json, tempfile, time, shutil, subprocess
from pathlib import Path

def report_progress(item, total):
    # hook into existing progress system if available
    pass

def load_manifest(engine_id):
    p = Path(__file__).with_suffix('').parent.parent / "filters/vectorize_engines" / f"{engine_id}.json"
    return json.loads(p.read_text())

def run_vtracer(input_path, opts):
    from app.shell import run_command  # privilege: use existing shell module
    out = input_path.replace(".png","_vtracer.svg").replace(".jpg","_vtracer.svg")
    cmd = ["vtracer", input_path, "-o", out]
    # preset mapping handled by option expansion if needed
    return {"svg_path": out, "elapsed_s": 0.0}

def run_inkscape(input_path, opts):
    from app.shell import run_command
    out = input_path.replace(".png","_inkscape.svg").replace(".jpg","_inkscape.svg")
    cmd = ["inkscape", input_path, "--export-type=svg", "--export-filename="+out]
    return {"svg_path": out, "elapsed_s": 0.0}

def run_neural(input_path, opts):
    # GPU check; lazy import torch only when enabled
    try:
        import torch
        if not torch.cuda.is_available():
            return {"error":"GPU not available — neural disabled", "svg_path":None}
    except Exception as e:
        return {"error":"torch unavailable: "+str(e), "svg_path":None}
    out = input_path.replace(".png","_neural.svg").replace(".jpg","_neural.svg")
    # DiffVG loop placeholder (full loop out of scope for skeleton)
    return {"svg_path": out, "elapsed_s": 0.0}

def orchestrate(enabled_ids, options, input_path):
    results = []
    for eid in enabled_ids:
        try:
            manifest = load_manifest(eid)
            opts = options.get(eid, {})
            if eid == "vtracer":
                res = run_vtracer(input_path, opts)
            elif eid == "inkscape":
                res = run_inkscape(input_path, opts)
            elif eid == "neural":
                res = run_neural(input_path, opts)
            else:
                res = {"error":"unknown engine"}
            res["engine_id"] = eid
            results.append(res)
        except Exception as e:
            results.append({"engine_id": eid, "error": str(e)})
    return results
