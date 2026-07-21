# app — Core FastAPI Server Package

The core Python package for `mtapi-project`. It provides dynamic OpenAPI route generation, execution contracts, subprocess isolation, media store hashing, and static WebUI delivery.

---

## 📁 File & Directory Layout

```
app/
├── __init__.py          # Python package initialization
├── main.py              # FastAPI app instance, dynamic routes, media store endpoints
├── contract.py          # Data contracts (OperationResult, OperationSpec, REGISTRY)
├── shell.py             # Async subprocess launcher and CLI binary checker
├── media_store.py       # Persistent BLAKE2b content-addressable media registry
├── operations/          # Tool operation definitions (transmute & datamosh schemas)
└── static/              # Single-page web application frontend
```

---

## 🧩 Module Overview

### 1. `contract.py`
Defines the universal operation contract:
- `OperationResult`: Standardized JSON output shape (`ok`, `operation`, `output_path`, `dry_run`, `command`, `stdout`, `stderr`, `error`).
- `OperationSpec`: Dataclass registering operation metadata, Pydantic parameter schemas, and async execution handlers.
- `REGISTRY`: Global dictionary mapping operation IDs to `OperationSpec`.

### 2. `main.py`
- Instantiates `FastAPI(title="multitool API")`.
- Iterates over `contract.REGISTRY` at startup to dynamically mount `POST /ops/{operation_id}` endpoints.
- Serves media browsing & metadata endpoints (`/media/workspace`, `/media/store`, `/media/probe`, `/media/pool`).
- Mounts `/static` and serves `/` (`index.html`).

### 3. `shell.py`
- Executes commands asynchronously via `asyncio.create_subprocess_exec` (avoiding shell injection).
- Provides output parsing (`parse_line`) for extracting `Output:` and `Command:` lines printed by CLI tools.
- Runs startup checks (`check_tools`) for missing binaries.

### 4. `media_store.py`
- Content-addressed media index stored in `~/.cache/mtapi/media/`.
- Computes BLAKE2b 128-bit hashes (32-char hex) to uniquely identify media files across renames or moves.
- Automatically extracts and caches first/last video thumbnail frames (`first.jpg`, `last.jpg`).

---

## 🔗 Subpackages
- [Operations Subpackage README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/operations/README.md)
- [Static WebUI Subpackage README](file:///home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/static/README.md)
