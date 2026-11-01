from fastapi import APIRouter, UploadFile, File, Form
from pydantic import BaseModel
import tempfile, os, shutil
from pathlib import Path
router = APIRouter(prefix="/vectorize")

class RunRequest(BaseModel):
    enabled: list[str]
    options: dict

@router.post("/upload")
def upload(file: UploadFile = File(...)):
    job_id = "j" + str(os.getpid())
    tmp = Path("/tmp/fftransmute_vectorize") / job_id
    tmp.mkdir(parents=True, exist_ok=True)
    out = tmp / "input.png"
    with open(out, "wb") as f:
        f.write(file.file.read())
    return {"ok": True, "job_id": job_id, "temp_png_path": str(out)}

@router.get("/status")
def status():
    # dependency check
    engines = []
    for e in ["vtracer","inkscape","neural"]:
        available = True
        reason = None
        engines.append({"id":e,"available":available,"reason":reason})
    return {"ok": True, "engines": engines, "openvino_device":"CPU"}

@router.post("/run")
def run(req: RunRequest):
    from app.operations import vectorize_ops
    # for skeleton: single-file demo; batch can extend
    input_path = "/tmp/fftransmute_vectorize/demo/input.png"
    results = vectorize_ops.orchestrate(req.enabled, req.options, input_path)
    return {"ok": True, "results": results}

@router.get("/results/{job_id}")
def results(job_id: str):
    return {"ok": True, "results": []}

@router.get("/download/{job_id}")
def download(job_id: str, format: str = "zip"):
    return {"ok": True, "path": "/tmp/fftransmute_vectorize/"+job_id+"/output.zip"}
