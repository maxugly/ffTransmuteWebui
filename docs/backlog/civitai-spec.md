# Spec: CivitAI Cloud Generation Integration

> **Version**: 000.000.4.00 (next major feature bump)
> **Status**: Proposed
> **Author**: Spec agent
> **Scope**: New operation — `civitai_ops.py` + `civitai_client.py` + WebUI "CivitAI Gen" tab

---

## 1. What It Does

Integrates CivitAI's cloud generation capabilities (text2img, img2img, img2vid) directly into the ffTransmuteWebui. It uses the CivitAI v2 Orchestration API to submit generation workflows, poll for completion, and download the resulting media, making it accessible from our local WebUI alongside other operations.

This allows us to prompt, pick models, set parameters, check Buzz cost, and generate directly within the app, removing the need to switch to the CLI or TUI.

---

## 2. API Endpoints and Step Types

We interact with the **CivitAI Orchestration API** (`https://orchestration.civitai.com` or `https://civitai.com/api/v2/consumer/workflows`). 

### Core Endpoints:
- `POST /v2/consumer/workflows`: Submit a generation job (supports `?whatif=true` for cost checking).
- `GET /v2/consumer/workflows/{workflowId}`: Poll for job status.
- Download URL: Extracted from the completed workflow response (or `/v2/consumer/blobs/{blobId}`).

### Step Types:
Based on the `@civitai/client` schemas and Orchestration API docs:
1. **`textToImage`**: Used for standard Text-to-Image generation.
2. **`imageToImage`**: Used for Image-to-Image. (Note: While early beta `@civitai/client` schemas mostly expose `textToImage`, raw REST payloads support `imageToImage` step types or `textToImage` with an `image` parameter/ControlNet).
3. **`imageToVideo` / `video` / `comfy`**: Used for img2vid workflows (e.g., WAN, Kling). Because the TypeScript client lacks explicit wrappers for these beta video steps, the Python client (`civitai_client.py`) will construct raw JSON dictionaries for the Orchestration API rather than relying on a typed SDK.

---

## 3. Parameter Models (Pydantic)

### File: `mtapi-project/app/operations/civitai_ops.py`

```python
from typing import Literal
from pydantic import BaseModel, Field

GenType = Literal["text2img", "img2img", "img2vid"]

class CivitaiParams(BaseModel):
    generation_type: GenType = Field(..., description="Type of generation workflow")
    
    # Inputs
    input_path: str | None = Field(None, description="Source image (required for img2img/img2vid)")
    output_path: str | None = Field(None, description="Output path; auto-named if omitted")
    
    # Core Gen Params
    model_air: str = Field(..., description="AIR of the model to use (e.g., urn:air:sdxl:checkpoint:...)")
    prompt: str = Field(..., description="Generation prompt")
    negative_prompt: str | None = Field(None, description="Negative prompt (if supported by model)")
    
    # Image geometry / quality
    width: int = Field(1024, description="Width in pixels")
    height: int = Field(1024, description="Height in pixels")
    steps: int = Field(20, description="Sampling steps")
    cfg_scale: float = Field(7.0, description="CFG Scale")
    seed: int | None = Field(None, description="Random seed (omitted for random)")
    sampler: str | None = Field("Euler a", description="Sampler to use")
    
    # Video specific
    video_length: int | None = Field(None, description="Duration/frames for video generation")
    
    # Execution control
    whatif: bool = Field(False, description="If True, return Buzz cost without spending/generating")
    dry_run: bool = False
```

---

## 4. Handler Pipeline (Submit → Poll → Download)

### File: `mtapi-project/app/operations/civitai_client.py`
A lightweight `httpx`-based client to wrap the REST calls (since no official Python SDK exists).
1. `submit_workflow(params, whatif=False)`: Authenticates via `~/.config/civitai/config.yaml` or `CIVITAI_API_TOKEN`. Constructs the JSON payload and POSTs. Returns job token or cost.
2. `poll_workflow(workflow_id)`: GETs status.
3. `download_blob(url, dest_path)`: Streams result to disk.

### File: `mtapi-project/app/operations/civitai_ops.py`

```
async def civitai_gen(p: CivitaiParams) -> OperationResult:
    1. Validate inputs (ensure input_path exists if img2img/img2vid).
    2. Resolve output path.
    3. If p.whatif:
       cost = await civitai_client.submit_workflow(p, whatif=True)
       return OperationResult(ok=True, stdout=f"Estimated Cost: {cost} Buzz")
       
    4. token = job_control.current_token()
    5. def progress_cb(msg): 
           job_control.report_progress(msg, token=token)
           job_control.check_cancelled()

    6. workflow = await civitai_client.submit_workflow(p)
       workflow_id = workflow["id"]
       progress_cb(f"Submitted workflow {workflow_id}")
       
    7. # Polling Loop
       while True:
           progress_cb("Polling status...")
           status = await civitai_client.poll_workflow(workflow_id)
           if status["state"] == "SUCCEEDED":
               break
           elif status["state"] in ["FAILED", "CANCELLED"]:
               return OperationResult(ok=False, error=f"Job {status['state']}")
           await asyncio.sleep(3)
           
    8. # Download
       progress_cb("Downloading result...")
       await civitai_client.download_blob(status["result_url"], out_path)
       
    9. return OperationResult(ok=True, output_path=out_path)
```

---

## 5. Operation Registration

In `app/operations/civitai_ops.py`:
```python
register(OperationSpec(
    id="civitai",
    summary="CivitAI Cloud Generation",
    description="Text2Img, Img2Img, and Img2Vid generation using CivitAI Orchestration API.",
    params_model=CivitaiParams,
    handler=civitai_gen,
    tags=["civitai", "generative", "cloud", "api"],
))
```
Add `civitai_ops` to `app/operations/__init__.py`.

---

## 6. WebUI Integration

### Tab Placement
New tab named **"CivitAI Gen"** under a new or existing generative category. Uses a cloud or spark SVG icon.

### Form Layout (`app/static/app.js` & `index.html`)
- **Type Toggle**: Radio buttons for [Text2Img] [Img2Img] [Img2Vid].
  - *Dynamic UI*: If Text2Img, hide "Input Video/Image". If Img2Vid, show "Video Length" slider.
- **Model Dropdown**: A pre-curated list of AIRs (e.g., SDXL, FLUX, Kling, WAN) or a simple text input for arbitrary AIRs.
- **Prompt Area**: Large textareas for Prompt and Negative Prompt.
- **Sliders**: Width, Height, Steps, CFG Scale.
- **Cost Check**: A dedicated button "Estimate Buzz Cost" (submits with `whatif=true`).
- **Run Button**: Submits the job. The terminal output area will stream the polling logs.

---

## 7. Files to Touch

| File | Action | Description |
|---|---|---|
| `app/operations/civitai_client.py` | **CREATE** | `httpx` wrapper for API auth, POST, polling, download. |
| `app/operations/civitai_ops.py` | **CREATE** | Pydantic model + async handler + `job_control` polling loop. |
| `app/operations/__init__.py` | **EDIT** | Add `civitai_ops` import. |
| `app/static/index.html` | **EDIT** | Add nav-item for CivitAI Gen. |
| `app/static/app.js` | **EDIT** | Form state, dynamic toggles (hide/show image inputs), collect params, route to `/ops/civitai`. |
| Root `AGENTS.md` | **EDIT** | Add to ops registry table. |

---

## 8. Open Questions

1. **Model Discovery**: Do we hardcode a curated list of AIRs (like `civitui` does) or fetch dynamically via the REST API? *Recommendation: Start with a curated list in `app.js` for simplicity, with a free-text override.*
2. **Video Workflows**: Are video APIs (Kling, WAN) fully stable on the consumer v2 API? If they use the `comfy` step type, we need exact JSON schema examples for the `comfy` node graph payload.

---

## 9. Pitfalls

- **Async Blocking**: Do not use `time.sleep()`. Must use `asyncio.sleep()` in the polling loop to avoid freezing the FastAPI event loop.
- **Cancellation**: Users clicking "Cancel" in the WebUI will trigger `job_control.check_cancelled()`. The handler must catch this and ideally issue a `PUT /v2/consumer/workflows/{id}` to cancel the job on CivitAI's end, saving Buzz.
- **Timeouts**: Cloud generation can take minutes. Polling must be robust to network blips.
- **Base64 vs URLs**: For img2img, the Orchestration API usually requires images to be uploaded to a blob store first, or provided as base64 data URIs. `civitai_client.py` must handle local file → base64 conversion before POSTing.
