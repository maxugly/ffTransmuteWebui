# AGENTS.md — Operations Subpackage Agent Directives

> **Scope**: Subpackage directory `/home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/operations`
> **Audience**: Autonomous AI Agents adding or modifying API operations, parameter schemas, and CLI tool wrappers.

---

## 🎯 1. Mission & Standard Protocols

This directory contains the typed operations bridge. Each tool operation must map clean input parameters (via Pydantic) to shell CLI calls and output standard `OperationResult` models.

---

## 📝 2. Step-by-Step Protocol for Adding a New Operation

To add a new tool or operation (e.g., `watermark_ops.py` or a new flag on `transmute`):

1. **Define Pydantic Parameter Model**:
   ```python
   class MyOpParams(BaseModel):
       input_path: str = Field(..., description="Absolute path to input video")
       output_path: str | None = Field(None, description="Optional output path")
       dry_run: bool = Field(False, description="If True, print command without executing")
   ```
2. **Implement Async Handler**:
   - Compute `cwd` from `input_path` using `_cwd_for(params.input_path)`.
   - Ensure `output_path` ends with a valid extension (e.g., via `_ensure_video_output_path`).
   - Call `run_command(argv, cwd=cwd)`.
   - Parse `Output:` and `Command:` lines from stdout using `parse_line`.
   - Construct and return `OperationResult`.
3. **Register `OperationSpec`**:
   ```python
   register(OperationSpec(
       id="my_op",
       summary="Short title",
       description="Detailed description for OpenAPI docs",
       params_model=MyOpParams,
       handler=handle_my_op,
       tags=["My Tool Tag"],
   ))
   ```
4. **Register Module Import**:
   - Add `from . import my_ops  # noqa: F401` inside `app/operations/__init__.py`.

---

## 🔒 3. Mandatory Safety Requirements

1. **Input Path CWD Resolution**:
   - Tools like `transmute` print bare output filenames (`video_1x1s.mp4`). Without passing `cwd` equal to `os.path.dirname(os.path.abspath(input_path))` to `run_command`, outputs land in the server process startup folder instead of next to the source file.
2. **Absolute Output Path Normalization**:
   - Parsed `Output:` strings must be resolved to absolute paths before returning in `OperationResult.output_path`.
3. **Muxer Extension Safeguard**:
   - ffmpeg fails when writing to paths without explicit file extensions (e.g., `/tmp/output_123`). Always sanitize output paths with `_ensure_video_output_path`.
