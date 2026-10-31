

# Orchestrator Agent Workspace — Spec

> Status: Proposed
> Kind: E (UI-only workspace with thin backend ops)
> Stage: n/a

## Problem
Currently, interacting with the local LangGraph multi-agent orchestrator requires leaving the ffTransmute WebUI and using external tools like LangSmith Studio or a terminal CLI. Users need a unified, native workspace within ffTransmute to start the agent daemon, chat with the orchestrator, and pass local media files for context without breaking their creative flow.

## Goals / Non-goals
**Goals:**
- Provide a UI toggle to start/stop the local LangGraph daemon process.
- Implement a vanilla JS chat interface that proxies messages to the LangGraph REST API (`localhost:2024`) and streams responses.
- Allow users to upload files (images/videos) directly into the chat, saving them to a job workspace and passing absolute paths to the agent.
- Strictly adhere to `OperationResult` for all backend ops.

**Non-goals:**
- Building a visual graph editor or modifying the underlying LangGraph agent architecture.
- Supporting remote/cloud LangGraph endpoints (local only).
- Reimplementing the neural/frame effects pipelines (the agent will call existing tools).

## User story
1. User opens the new "Agent" tab.
2. User toggles the "Orchestrator Daemon" switch to ON.
3. The backend starts the `langgraph dev` process, and the UI shows a "Connected" state.
4. User types a request and clicks "Send".
5. User clicks the "Attach" (paperclip) button, selects `/tmp/teste.png`, and the UI shows the file chip.
6. User sends the message. The UI sends the text and the absolute path of the uploaded file to the agent.
7. The agent's response streams back into the chat window, and the user can continue the conversation.

## Params (JSON)

### 1. `POST /ops/orchestrator/daemon`
```json
{
  "action": "start" | "stop" | "status"
}
```
*Response uses standard `OperationResult`.*

### 2. `POST /ops/orchestrator/upload` 
*Multipart form data. Saves file via `pathutil.finalize_output_path` and returns absolute path.*
```json
{
  "output_path": "/abs/path/to/uploads/filename_0001.png"
}
```

### 3. `POST /ops/orchestrator/chat`
```json
{
  "thread_id": "uuid-string",
  "message": "string",
  "file_paths": ["/abs/path/to/uploads/filename_0001.png"]
}
```

## Architecture (reuse bookends/filters?)
- **Frontend:** New vanilla JS module `js/tabs/orchestrator.js`. Uses standard `fetch()` for ops and `ReadableStream` for parsing Server-Sent Events (SSE) from the chat proxy.
- **Backend:** New `operations/orchestrator_ops.py`.
  - `daemon_op`: Uses `create_subprocess_exec` (no `shell=True`) to manage the `langgraph dev` process. Must handle port 2024 conflicts.
  - `upload_op`: Saves the uploaded file to the active `JobWorkspace` and returns the absolute path.
  - `chat_op`: Acts as a secure proxy, taking the JSON payload, forwarding it to `http://localhost:2024/runs/stream`, and streaming the chunks back to the frontend.
- **Reuse:** `shell.run_command` for daemon control and `pathutil` for uploads.

## Files to touch
- **Backend:**
  - `mtapi-project/app/operations/orchestrator_ops.py` (New)
  - `mtapi-project/app/main.py` (Register ops)
- **Frontend:**
  - `mtapi-project/app/static/js/tabs/orchestrator.js` (New)
  - `mtapi-project/index.html` (Add tab button and container)
  - `mtapi-project/app/static/css/tabs.css` (Chat UI styles)
- **Docs:** `docs/orchestrator-tab-spec.md`

## UI
- **Tab Header:** "Agent Workspace"
- **Top Bar:** A toggle switch labeled "Orchestrator Daemon". Red = OFF, Green = ON. Displays a loading spinner while starting.
- **Main Area:** Scrollable chat history. User messages on the right, Agent on the left. 
- **Bottom Bar:** 
  - Text input field.
  - "Attach" (paperclip) icon button that opens a file picker.
  - "Send" button.
  - Uploaded files appear as small chips above the input field with an "X" to remove. 
- **Empty/Error States:** If the daemon is OFF, the chat input is disabled and shows "Start daemon to chat."

## Edge cases
- **Port Conflict:** If port 2024 is already in use, the daemon start op returns `ok: false` with a clear error message.
- **Daemon Crash:** If the process dies unexpectedly, the UI toggle flips back to OFF and displays an error banner.
- **Upload Limits:** Reject files > 50MB or unsupported extensions (`.png`, `.jpg`, `.mp4`, `.txt`) with `ok: false`.
- **Stream Disconnect:** If the chat stream drops mid-response, show a "Connection lost" warning but preserve the partial text.
- **Cancel:** Spec supports cancelling a long-running chat request via existing `job_control`.

## Acceptance tests
- **Backend:**
  - `POST /ops/orchestrator/daemon` with `{"action": "start"}` returns `ok: true`.
  - `POST /ops/orchestrator/upload` with `/tmp/teste.png` returns `ok: true` and the new absolute path.
  - `POST /ops/orchestrator/chat` with `/tmp/teste.mp4` in `file_paths` returns a 200 stream and proxies correctly.
- **WebUI:**
  - Toggle switch changes state, triggers the correct backend op, and shows loading state.
  - Sending a message updates the chat UI and handles SSE streaming chunks.
  - Uploading `/tmp/teste.png` displays the chip and passes the path in the chat payload.
  - **Zero JS console errors** on page load and interaction.

## Risks / follow-ups
- **Risks:** 
  - FastAPI proxying Server-Sent Events (SSE) can be tricky; ensure the proxy response does not buffer.
  - Starting the LangGraph daemon might take a few seconds; the UI must handle asynchronous state gracefully.
- **Follow-ups:** 
  - Add a "Clear Chat" button.
  - Display token usage or cost for the cloud models in the chat UI.
  - Add a dropdown to select which LangGraph thread to resume.
