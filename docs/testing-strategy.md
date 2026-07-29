# Testing Strategy

> **Status:** Active Reference
> **Scope:** Entire Workspace

This document formalizes our testing approach to prevent recurring bugs and ensure stability across both the backend pipeline and the frontend WebUI. 

---

## 1. Playwright MCP for WebUI (Primary Testing Path)
Testing via the API only proves the backend responds, but it completely misses JS errors, broken CSS, and form submission bugs. **The WebUI is the source of truth for end-to-end testing.**

Agents must use Playwright MCP tools (`mcp_mcp_browser_*`) to simulate a real user session. 
- **NEVER** use `web.run` or `web_search` for this, as they block localhost connections.
- **NEVER** fall back to curl for UI verification.

### Standard Test Assets
Ensure these assets exist before running a test:
- **Video:** `/tmp/teste.mp4` (2s duration, 320x240, 24fps, with audio)
- **Image:** `/tmp/teste.png` (1-frame still, 320x240)

*Generation scripts for these assets are in `AGENTS.md` (Root).*

### The Browser Smoke Test Template
Copy and paste this exact prompt template when asking an agent to verify a WebUI feature:

```markdown
Run a browser smoke test for the {OPERATION_NAME} tab.
1. Connect to Playwright MCP (`start_mcp_server with @playwright/mcp` if needed).
2. Navigate to `http://localhost:24590/`
3. Click the tab for {OPERATION_NAME}.
4. Snapshot the page to verify the form rendered correctly with all expected controls.
5. Type `/tmp/teste.mp4` (or `/tmp/teste.png` for images) into the input field.
6. Click the "Run Operation" button.
7. Read the browser console for any JS errors.
8. Wait for the operation to complete and verify the UI shows success.
Clean up the test output files from `/tmp/` when finished.
```

## 2. Identity Pipeline (Backend Testing)
For testing the core `VideoPipeline` and backend orchestration without risking complex neural engine failures:
- **Identity Filter:** Use a no-op (identity) `filter_fn` that simply copies `input_png` to `output_png`.
- **Purpose:** Verifies the `dump -> process -> encode` lifecycle, path resolution, audio muxing, and workspace cleanup independent of external AI model weights.
- **Verification:** The output video should be an exact match (length, dimensions, audio) to the input video.

## 3. Regression Sweep Before Major Commits
Before bumping a major version or completing a complex phase (e.g., Phase 4 Pipeline migration):
1. Start the server from a clean state.
2. Run the Playwright smoke test on at least **3 different operations** (e.g., `rife`, `withoutbg`, and `transmute`) to ensure shared code changes didn't break unrelated tabs.
3. Verify the Media Pool auto-imports the new files correctly.
4. Verify the terminal outputs do not show silent subprocess crashes.

## 4. Per-Extraction Node `--check`
When modifying Bash scripts or standalone binaries (`transmute`, `datamosh.sh`):
- Run a manual CLI extraction/process check before integrating it back into the FastAPI backend.
- Ensure the binary exits with `0` on success and `>0` on failure, so the Python `shell.py` wrapper catches errors correctly.
- Verify that default behavior (without scaling or interpolation flags) strictly preserves pixel geometry and aspect ratios.
