"""Standalone OpenAI-compatible FastAPI worker for OpenVINO GenAI on GPU/CPU/NPU.

Launched inside a memory cage by `app.openvino_llm.supervisor` on `<host>:<port>`
(default `127.0.0.1:2431`).

Default: Intel AI Playground's installed OVMS executable, launched under the
same memory cage as the cold HTTP facade; native tool/vision/chat processing.
Legacy Python GenAI mode preserves methods from `/home/m/snc/cod/vinoapi`:
- Dynamic KV allocation via `scheduler_config=openvino_genai.SchedulerConfig()`
  (mirrors Intel AI Playground `ovms --cache_size 0`, avoiding 40,960-token prealloc OOM).
- `KV_CACHE_PRECISION="u4"` (configurable) + `CACHE_DIR` / `GPU_PLUGIN_CACHE_DIR` reuse.
- Preflight `MemAvailable` check + single-hot-model invariant (never >1 model in RAM).
- In-process self-RSS and optional floor watchdog from `scripts/smoke.py`.
- Lenient OpenAI/Cline request parsing + SSE prefill keep-alive heartbeats so
  60-90s iGPU prefills never 422 or time out mid-stream.

Spec: docs/openvino-tab-spec.md §2, §3, §8
"""
from __future__ import annotations

import asyncio
import anyio
import ctypes
import gc
import json
import logging
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from .cage import detect_orphaned_ovms, mem_available_mb, process_rss_mb
from .config import (
    DEFAULT_MODEL_ID,
    build_v1_model_card,
    build_v1_models_payload,
    load_config,
)
from .playground import PlaygroundRuntime, chat as playground_chat
from . import activity

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger("vinoapi")
logging.getLogger("uvicorn.access").addFilter(activity.QuietPolls())

_gen_lock = threading.Lock()
_load_lock = threading.RLock()
_request_gate = asyncio.Lock()

_state: dict[str, Any] = {
    "model_state": "cold",  # "cold" | "loading" | "hot" | "unloading" | "error"
    "pipe": None,
    "tok": None,
    "loaded_model_id": None,
    "loaded_model_path": None,
    "device": None,
    "kv_cache_precision": None,
    "load_duration_s": None,
    "last_error": None,
    "generating": False,
    "started_at": time.time(),
    "baseline_rss_mb": 64,
    "loop": None,
    "watchdog_stop": None,
}


def _malloc_trim() -> None:
    """Return freed C++/OpenVINO heap arenas back to the OS kernel immediately."""
    try:
        libc = ctypes.CDLL("libc.so.6")
        libc.malloc_trim(0)
    except Exception:
        pass


def _start_watchdog() -> threading.Event:
    """Daemon memory watchdog adapted from `/home/m/snc/cod/vinoapi/scripts/smoke.py`."""
    stop = threading.Event()
    strikes = 0
    last_status = 0.0
    t_start = time.time()

    def _loop() -> None:
        nonlocal strikes, last_status
        while not stop.is_set():
            cfg = load_config()
            floor_on = cfg.cage.watchdog_floor_enabled or (
                os.environ.get("VINO_WATCHDOG_FLOOR") == "on"
            )
            min_mb = cfg.cage.watchdog_min_mb
            rss_cap = int(os.environ.get("VINO_RSS_CAP_MB", cfg.cage.rss_cap_mb))
            avail, _ = mem_available_mb()
            rss = process_rss_mb()

            if floor_on and avail > 0 and avail < min_mb:
                strikes += 1
                if strikes >= 20:
                    log.error(
                        "[watchdog] ABORT: system MemAvailable %dMB < %dMB for %.1fs",
                        avail,
                        min_mb,
                        strikes * 0.25,
                    )
                    os._exit(3)
            else:
                strikes = 0

            if rss > rss_cap:
                log.error(
                    "[watchdog] ABORT: self RSS %dMB > %dMB (probable cache miss -> recompile)",
                    rss,
                    rss_cap,
                )
                os._exit(4)

            now = time.time()
            if _state.get("model_state") in ("loading", "hot") and (now - last_status >= 30.0):
                last_status = now
                log.info(
                    "[%.1fs] watchdog: state=%s avail=%dMB rss=%dMB",
                    now - t_start,
                    _state.get("model_state"),
                    avail,
                    rss,
                )
            time.sleep(0.25)

    t = threading.Thread(target=_loop, daemon=True, name="vinoapi-watchdog")
    t.start()
    return stop


def _unload_locked() -> dict[str, Any]:
    """Unload current pipeline while holding `_load_lock`. Never keeps >1 model hot."""
    prev_model = _state.get("loaded_model_id")
    _state["model_state"] = "unloading"
    if isinstance(_state.get("pipe"), PlaygroundRuntime):
        _state["pipe"].close()
    _state["pipe"] = None
    _state["tok"] = None
    _state["loaded_model_id"] = None
    _state["loaded_model_path"] = None
    _state["device"] = None
    _state["kv_cache_precision"] = None
    gc.collect()
    _malloc_trim()
    _state["model_state"] = "cold"
    rss = process_rss_mb()
    _state["baseline_rss_mb"] = min(_state.get("baseline_rss_mb") or rss, rss)
    avail, _ = mem_available_mb()
    log.info("Pipeline unloaded (prev=%s, rss=%dMB, avail=%dMB)", prev_model, rss, avail)
    return {
        "unloaded_model_id": prev_model,
        "process_rss_mb": rss,
        "mem_available_mb": avail,
    }


def unload_pipeline_sync() -> dict[str, Any]:
    with _gen_lock:
        with _load_lock:
            return _unload_locked()


def load_pipeline_sync(
    model_id: str | None = None,
    model_path: str | None = None,
    device: str | None = None,
    kv_cache_precision: str | None = None,
) -> dict[str, Any]:
    """Load a single LLMPipeline into RAM/VRAM, enforcing the single-hot-model rule
    and the preflight MemAvailable guard.
    """
    with _load_lock:
        cfg = load_config()
        entry = cfg.find_model(model_id)
        target_id = model_id or entry.id or DEFAULT_MODEL_ID
        target_path = str(
            model_path or entry.model_path or cfg.runtime.model_path
        ).strip()
        from .profiles import effective_runtime
        cfg.runtime = effective_runtime(cfg, entry)
        target_device = str(device or cfg.runtime.device or "GPU").strip().upper()
        target_kv = str(kv_cache_precision or cfg.runtime.kv_cache_precision or "u4").strip()
        cache_dir = str(cfg.runtime.cache_dir).strip()
        preflight_mb = int(cfg.runtime.preflight_min_mb)

        # Single-Hot-Model Invariant: ALWAYS unload any existing hot model first!
        if _state.get("pipe") is not None:
            log.info(
                "Unloading existing model %r before loading %r (single-hot-model rule)",
                _state.get("loaded_model_id"),
                target_id,
            )
            _unload_locked()

        model_dir = Path(target_path).expanduser()
        if not model_dir.is_dir():
            err = f"Model directory not found: {target_path}"
            _state["model_state"] = "cold"
            _state["last_error"] = err
            raise RuntimeError(err)

        xml_file = model_dir / "openvino_model.xml"
        if cfg.runtime.engine == "genai" and not xml_file.is_file():
            err = f"openvino_model.xml not found in {target_path}"
            _state["model_state"] = "cold"
            _state["last_error"] = err
            raise RuntimeError(err)

        avail, _ = mem_available_mb()
        log.info("MemAvailable before load: %dMB (policy=%s, custom minimum=%dMB)", avail, cfg.runtime.preflight_policy, preflight_mb)
        if cfg.runtime.preflight_policy == "fixed" and avail < preflight_mb:
            orphans = detect_orphaned_ovms(exclude_pid=os.getpid())
            orphan_hint = ""
            if orphans:
                pids = ", ".join(f"PID {o['pid']} ({o['rss_mb']}MB)" for o in orphans)
                orphan_hint = (
                    f" Detected running Intel AI Playground ovms process ({pids}) "
                    "holding GPU memory — stop AI Playground/ovms first."
                )
            err = (
                f"Not enough memory headroom ({avail}MB < preflight {preflight_mb}MB); "
                f"close apps / let swap drain or lower Preflight Min MB.{orphan_hint}"
            )
            _state["model_state"] = "cold"
            _state["last_error"] = err
            raise RuntimeError(err)

        _state["model_state"] = "loading"
        _state["load_started"] = time.monotonic()
        _state["reply_verified"] = False
        _state["last_request"] = None
        _state["last_error"] = None
        if cache_dir:
            Path(cache_dir).expanduser().mkdir(parents=True, exist_ok=True)
            os.environ["GPU_PLUGIN_CACHE_DIR"] = cache_dir

        t0 = time.time()
        try:
            if cfg.runtime.engine == "playground":
                pipe = PlaygroundRuntime(cfg, entry, model_dir, target_device, target_kv)
                tok = None
            else:
                import openvino_genai as g
                pipe_kwargs: dict[str, Any] = {"scheduler_config": g.SchedulerConfig()}
                if cache_dir:
                    pipe_kwargs["CACHE_DIR"] = cache_dir
                if target_kv and target_kv.lower() != "auto":
                    pipe_kwargs["KV_CACHE_PRECISION"] = target_kv
                pipe = g.LLMPipeline(str(model_dir), target_device, **pipe_kwargs)
                tok = pipe.get_tokenizer()
        except Exception as exc:
            _state["pipe"] = None
            _state["tok"] = None
            _state["model_state"] = "cold"
            _state["last_error"] = str(exc)
            gc.collect()
            log.exception("LLMPipeline constructor failed")
            raise RuntimeError(f"Failed to load OpenVINO pipeline: {exc}") from exc

        dt = round(time.time() - t0, 2)
        _state["pipe"] = pipe
        _state["tok"] = tok
        _state["loaded_model_id"] = target_id
        _state["loaded_model_path"] = str(model_dir)
        _state["device"] = target_device
        _state["kv_cache_precision"] = target_kv
        _state["load_duration_s"] = dt
        _state["model_state"] = "hot"
        _state["last_error"] = None
        log.info(
            "pipeline loaded in %.1fs: model=%s device=%s kv=%s rss=%dMB",
            dt,
            target_id,
            target_device,
            target_kv,
            process_rss_mb(),
        )
        return worker_status_snapshot()


def worker_status_snapshot() -> dict[str, Any]:
    avail, total = mem_available_mb()
    rss = process_rss_mb()
    pipe = _state.get("pipe")
    if isinstance(pipe, PlaygroundRuntime):
        if not pipe.running:
            _state["model_state"] = "error"
            _state["last_error"] = pipe.error or "Playground OVMS process exited"
        if pipe.proc is not None:
            rss += process_rss_mb(pipe.proc.pid)
    baseline = _state.get("baseline_rss_mb") or 64
    hot = _state.get("model_state") == "hot" and _state.get("pipe") is not None
    return {
        "state": _state.get("model_state", "cold"),
        "activity": activity.snapshot(_state, _request_gate.locked(), load_config().timeout_ms / 1000),
        "engine": "playground" if isinstance(pipe, PlaygroundRuntime) else "genai" if pipe else load_config().runtime.engine,
        "engine_pid": pipe.proc.pid if isinstance(pipe, PlaygroundRuntime) and pipe.proc else None,
        "engine_argv": pipe.argv if isinstance(pipe, PlaygroundRuntime) else None,
        "preflight_policy": load_config().runtime.preflight_policy,
        "hot": hot,
        "loaded_model_id": _state.get("loaded_model_id"),
        "loaded_model_path": _state.get("loaded_model_path"),
        "device": _state.get("device"),
        "kv_cache_precision": _state.get("kv_cache_precision"),
        "load_duration_s": _state.get("load_duration_s"),
        "generating": bool(_state.get("generating", False)),
        "request_active": _request_gate.locked(),
        "keep_loaded": _keep_model_loaded(),
        "release_pending": _request_gate.locked() and not _keep_model_loaded(),
        "request_elapsed_s": round(time.monotonic() - _state['request_started'], 1) if _request_gate.locked() and _state.get('request_started') else 0,
        "reply_updates": _state.get('reply_updates', 0),
        "last_reply_age_s": round(time.monotonic() - _state['last_reply_at'], 1) if _request_gate.locked() and _state.get('last_reply_at') else None,
        "process_rss_mb": rss,
        "model_mem_used_mb": max(0, rss - baseline) if hot else 0,
        "mem_available_mb": avail,
        "mem_total_mb": total,
        "last_error": _state.get("last_error"),
        "pid": os.getpid(),
        "uptime_s": round(max(0.0, time.time() - (_state.get("started_at") or time.time())), 1),
    }


def normalize_message_content(msg: dict[str, Any]) -> str:
    """Convert any OpenAI/Cline message content shape (`str | list | None`) into a plain `str`.

    Fixes the `422 Unprocessable Entity` crash when Cline sends content block arrays
    (`[{"type": "text", "text": "..."}]`) or `content: null` on tool_calls turns.
    """
    content = msg.get("content")
    parts: list[str] = []

    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                btype = item.get("type", "")
                if btype in ("text", "input_text", "output_text") or "text" in item:
                    parts.append(str(item.get("text") or ""))
                elif "content" in item and isinstance(item["content"], str):
                    parts.append(item["content"])
    elif content is not None:
        parts.append(str(content))

    # Preserve tool_calls information if content was null/empty
    tool_calls = msg.get("tool_calls")
    if isinstance(tool_calls, list) and tool_calls:
        tc_strs = []
        for tc in tool_calls:
            if isinstance(tc, dict):
                fn = tc.get("function") or {}
                name = fn.get("name") or tc.get("name") or "tool"
                args = fn.get("arguments") or tc.get("arguments") or "{}"
                tc_strs.append(f"[Tool Call: {name}({args})]")
        if tc_strs:
            parts.append("\n".join(tc_strs))

    return "\n".join(p for p in parts if p != "")


def normalize_messages(raw_messages: Any) -> list[dict[str, str]]:
    """Normalize a list of OpenAI/Cline messages into `[{"role": str, "content": str}]`."""
    if not isinstance(raw_messages, list):
        return []
    normalized: list[dict[str, str]] = []
    for raw in raw_messages:
        if not isinstance(raw, dict):
            continue
        role = str(raw.get("role") or "user").strip().lower()
        if role == "developer":
            role = "system"
        text = normalize_message_content(raw)
        if role == "tool":
            tool_name = raw.get("name") or raw.get("tool_call_id") or "tool"
            role = "user"
            text = f"[Tool Result ({tool_name})]:\n{text}"
        normalized.append({"role": role, "content": text})
    return normalized


def _chunk(
    req_id: str,
    created: int,
    model: str,
    delta: dict[str, Any],
    finish: str | None = None,
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": req_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    if usage is not None:
        payload["usage"] = usage
    return payload


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _state["started_at"] = time.time()
    _state["baseline_rss_mb"] = max(16, process_rss_mb())
    _state["loop"] = asyncio.get_running_loop()
    _state["watchdog_stop"] = _start_watchdog()
    cfg = load_config()
    try:
        oom_adj = int(os.environ.get("VINO_OOM_SCORE_ADJUST", str(cfg.cage.oom_score_adjust)))
        Path("/proc/self/oom_score_adj").write_text(f"{max(-1000, min(1000, oom_adj))}\n", encoding="utf-8")
    except Exception:
        pass
    log.info(
        "Worker online (Model Cold, pid=%d, rss=%dMB, port=%d)",
        os.getpid(),
        _state["baseline_rss_mb"],
        cfg.port,
    )
    auto_load = os.environ.get("VINO_AUTO_LOAD_ON_START", "").lower() in ("1", "true", "yes") or (
        cfg.runtime.auto_load_on_start
    )
    if auto_load:
        async def _bg_load() -> None:
            try:
                await asyncio.to_thread(load_pipeline_sync)
            except Exception as exc:
                log.warning("Auto-load on start skipped/failed: %s", exc)

        asyncio.create_task(_bg_load())
    try:
        yield
    finally:
        stop_ev = _state.get("watchdog_stop")
        if stop_ev is not None:
            stop_ev.set()
        try:
            unload_pipeline_sync()
        except Exception:
            pass
        _state.clear()


app = FastAPI(title="vinoapi-worker", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    cfg = load_config()
    snap = worker_status_snapshot()
    return {
        "status": "ok",
        "server_state": "up",
        "model_state": snap["state"],
        "hot": snap["hot"],
        "model": snap["loaded_model_id"] or cfg.active_model_id,
        "device": snap["device"] or cfg.runtime.device,
        "kv_cache_precision": snap["kv_cache_precision"] or cfg.runtime.kv_cache_precision,
        "process_rss_mb": snap["process_rss_mb"],
        "mem_available_mb": snap["mem_available_mb"],
    }


@app.get("/v1/models")
async def list_models():
    cfg = load_config()
    return build_v1_models_payload(cfg, loaded_model_id=_state.get("loaded_model_id"))


@app.get("/v1/models/{model_id:path}")
async def get_model(model_id: str):
    cfg = load_config()
    entry = cfg.find_model(model_id)
    return build_v1_model_card(entry, cfg, loaded_model_id=_state.get("loaded_model_id"))


@app.get("/admin/status")
@app.get("/internal/status")
async def internal_status():
    cfg = load_config()
    snap = worker_status_snapshot()
    return {
        "ok": True,
        "server": {
            "state": "up",
            "running": True,
            "pid": snap["pid"],
            "uptime_s": snap["uptime_s"],
            "host": cfg.host,
            "port": cfg.port,
            "base_url": cfg.base_url,
            "model_source_url": cfg.model_source_url,
            "cage": cfg.cage.model_dump(mode="json"),
        },
        "model": snap,
        "config": cfg.model_dump(mode="json"),
    }


@app.post("/admin/load")
@app.post("/internal/load")
async def internal_load(request: Request):
    body: dict[str, Any] = {}
    try:
        raw = await request.body()
        if raw:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                body = parsed
    except Exception:
        pass
    try:
        snap = await asyncio.to_thread(
            load_pipeline_sync,
            model_id=body.get("model_id"),
            model_path=body.get("model_path"),
            device=body.get("device"),
            kv_cache_precision=body.get("kv_cache_precision"),
        )
        return {"ok": True, "model": snap}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "model": worker_status_snapshot()}


@app.post("/admin/unload")
@app.post("/internal/unload")
async def internal_unload():
    try:
        info = await asyncio.to_thread(unload_pipeline_sync)
        return {"ok": True, **info, "model": worker_status_snapshot()}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "model": worker_status_snapshot()}


async def _chat_completions_impl(request: Request):
    """OpenAI-compatible chat completions endpoint hardened for Cline."""
    try:
        body = await request.json()
    except Exception as exc:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": f"Invalid JSON request body: {exc}", "type": "invalid_request_error"}},
        )
    if not isinstance(body, dict):
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "Request body must be a JSON object", "type": "invalid_request_error"}},
        )

    cfg = load_config()
    if cfg.enforce_api_key and cfg.api_key:
        auth = request.headers.get("authorization") or ""
        token = auth.removeprefix("Bearer ").removeprefix("bearer ").strip()
        if token != cfg.api_key:
            return JSONResponse(
                status_code=401,
                content={"error": {"message": "Invalid API Key", "type": "authentication_error"}},
            )

    msgs = normalize_messages(body.get("messages"))
    if not msgs:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "messages must be a non-empty list", "type": "invalid_request_error"}},
        )

    req_model = str(body.get("model") or cfg.active_model_id or DEFAULT_MODEL_ID).strip()
    model_entry = cfg.find_model(req_model)

    # A request for another configured model must never run on the previous weights.
    if (_state.get("pipe") is None or _state.get("model_state") != "hot"
            or _state.get("loaded_model_id") != model_entry.id):
        if cfg.runtime.auto_load_on_request:
            try:
                await asyncio.to_thread(load_pipeline_sync, model_id=model_entry.id)
            except Exception as exc:
                return JSONResponse(
                    status_code=503,
                    content={
                        "error": {
                            "message": f"Model auto-load failed: {exc}",
                            "type": "server_error",
                            "code": "model_load_failed",
                        }
                    },
                )
        else:
            return JSONResponse(
                status_code=503,
                content={
                    "error": {
                        "message": (
                            "Model is currently Cold (unloaded). Click 'Load Model' in the "
                            "OpenVINO WebUI tab or enable 'Auto-load on chat request'."
                        ),
                        "type": "server_error",
                        "code": "model_cold",
                    }
                },
            )

    if isinstance(_state.get("pipe"), PlaygroundRuntime):
        # Preserve native multimodal/tool messages; OVMS owns tokenization/parsing.
        return await playground_chat(_state["pipe"], body, cfg, model_entry, _state, request=request)

    import openvino_genai as g

    pipe = _state["pipe"]
    tok = _state["tok"]
    loop: asyncio.AbstractEventLoop = _state.get("loop") or asyncio.get_running_loop()

    # Thinking toggle (Qwen3 extra_context)
    req_thinking = body.get("enable_thinking")
    think = bool(req_thinking) if req_thinking is not None else bool(model_entry.enable_thinking_default)
    from .profiles import supports_thinking
    tpl_kwargs: dict[str, Any] = {"extra_context": {"enable_thinking": think}} if supports_thinking(model_entry) else {}

    try:
        prompt = tok.apply_chat_template(msgs, add_generation_prompt=True, **tpl_kwargs)
    except Exception:
        # Fallback if tokenizer template does not support extra_context
        try:
            prompt = tok.apply_chat_template(msgs, add_generation_prompt=True)
        except Exception:
            prompt = "\n".join(f"{m['role']}: {m['content']}" for m in msgs) + "\nassistant: "

    try:
        prompt_tokens = int(tok.encode(prompt).input_ids.data.size)
    except Exception:
        prompt_tokens = max(1, len(prompt) // 4)

    gen_cfg = pipe.get_generation_config()
    req_max = body.get("max_tokens") or body.get("max_completion_tokens")
    try:
        max_new = int(req_max) if req_max is not None else int(model_entry.max_tokens_default)
    except (TypeError, ValueError):
        max_new = int(model_entry.max_tokens_default)
    max_new = max(1, min(max_new, int(model_entry.max_tokens)))
    gen_cfg.max_new_tokens = max_new
    gen_cfg.apply_chat_template = False  # already templated above

    temp = body.get("temperature", model_entry.temperature_default)
    if temp is not None:
        try:
            t_val = float(temp)
            gen_cfg.temperature = t_val
            gen_cfg.do_sample = t_val > 0
        except (TypeError, ValueError):
            pass

    top_p = body.get("top_p", model_entry.top_p_default)
    if top_p is not None:
        try:
            gen_cfg.top_p = float(top_p)
        except (TypeError, ValueError):
            pass

    for key in ('top_k', 'repetition_penalty'):
        value = body.get(key, getattr(model_entry, key + '_default'))
        if value is not None:
            setattr(gen_cfg, key, value)

    req_id = f"chatcmpl-{time.time_ns()}"
    created = int(time.time())
    stream = bool(body.get("stream", False))
    stream_options = body.get("stream_options") if isinstance(body.get("stream_options"), dict) else {}
    include_usage = bool(stream_options.get("include_usage", False))

    class _CollectStreamer(g.StreamerBase):
        def __init__(self, tokenizer):
            super().__init__()
            self.tok = tokenizer
            self.pieces: list[str] = []
            self.n = 0

        def write(self, t):
            self.n += 1
            pieces = self.tok.decode([t], skip_special_tokens=True)
            if pieces:
                if isinstance(pieces, str):
                    self.pieces.append(pieces)
                else:
                    self.pieces.extend(pieces)
            return g.StreamingStatus.RUNNING

        def end(self):
            pass

    class _AsyncStreamer(_CollectStreamer):
        def __init__(self, tokenizer, q: asyncio.Queue, ev_loop: asyncio.AbstractEventLoop):
            super().__init__(tokenizer)
            self.queue = q
            self.loop = ev_loop
            self._ended = False

        def write(self, t):
            self.n += 1
            pieces = self.tok.decode([t], skip_special_tokens=True)
            text = pieces if isinstance(pieces, str) else ("".join(pieces) if pieces else "")
            if text:
                self.loop.call_soon_threadsafe(self.queue.put_nowait, text)
            return g.StreamingStatus.RUNNING

        def end(self):
            if not self._ended:
                self._ended = True
                self.loop.call_soon_threadsafe(self.queue.put_nowait, None)

    if stream:
        queue: asyncio.Queue = asyncio.Queue()
        streamer = _AsyncStreamer(tok, queue, loop)
        keepalive_on = bool(cfg.runtime.enable_sse_keepalive)
        keepalive_s = max(1.0, float(cfg.runtime.sse_keepalive_interval_s or 5.0))

        def _run_stream() -> None:
            try:
                with _gen_lock:
                    _state["generating"] = True
                    pipe.generate(prompt, gen_cfg, streamer)
            except Exception as exc:
                log.exception("Streaming generate failed")
                loop.call_soon_threadsafe(queue.put_nowait, exc)
            finally:
                _state["generating"] = False
                streamer.end()

        threading.Thread(target=_run_stream, daemon=True, name="vinoapi-gen").start()

        async def _sse():
            # Flush the initial assistant role chunk immediately so Cline's
            # stream reader knows the response has started before 60-90s prefill.
            yield f"data: {json.dumps(_chunk(req_id, created, req_model, {'role': 'assistant', 'content': ''}))}\n\n"
            while True:
                try:
                    if keepalive_on:
                        piece = await asyncio.wait_for(queue.get(), timeout=keepalive_s)
                    else:
                        piece = await queue.get()
                except asyncio.TimeoutError:
                    # Standard SSE comment heartbeat keeps socket alive during 60-90s iGPU prefill
                    yield ": prefill-keepalive\n\n"
                    continue

                if piece is None:
                    break
                if isinstance(piece, Exception):
                    yield f"data: {json.dumps({'error': {'message': str(piece)}})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                yield f"data: {json.dumps(_chunk(req_id, created, req_model, {'content': piece}))}\n\n"

            finish = "length" if streamer.n >= gen_cfg.max_new_tokens else "stop"
            usage_obj = (
                {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": streamer.n,
                    "total_tokens": prompt_tokens + streamer.n,
                }
                if include_usage
                else None
            )
            yield f"data: {json.dumps(_chunk(req_id, created, req_model, {}, finish, usage=usage_obj))}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            _sse(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    collector = _CollectStreamer(tok)
    t_gen0 = time.time()

    def _gen_sync():
        with _gen_lock:
            _state["generating"] = True
            try:
                return pipe.generate(prompt, gen_cfg, collector)
            finally:
                _state["generating"] = False

    try:
        res = await asyncio.to_thread(_gen_sync)
    except Exception as exc:
        log.exception("Non-streaming generate failed")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(exc), "type": "server_error"}},
        )

    dt_gen = max(1e-6, time.time() - t_gen0)
    text = res if isinstance(res, str) else "".join(collector.pieces)
    finish = "length" if collector.n >= gen_cfg.max_new_tokens else "stop"
    return {
        "id": req_id,
        "object": "chat.completion",
        "created": created,
        "model": req_model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": finish,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": collector.n,
            "total_tokens": prompt_tokens + collector.n,
            "duration_s": round(dt_gen, 2),
            "tok_per_s": round(collector.n / dt_gen, 2) if collector.n else 0.0,
        },
    }


def _keep_model_loaded():
    from ..media.performance import load_settings
    return bool(load_settings().get('warm_models', {}).get('openvino', False))


@app.post('/internal/release-if-idle')
async def release_if_idle():
    if _request_gate.locked():
        return {'ok': True, 'release_pending': not _keep_model_loaded()}
    await _request_gate.acquire()
    try:
        if not _keep_model_loaded() and _state.get('pipe') is not None:
            await asyncio.to_thread(unload_pipeline_sync)
        return {'ok': True, 'model': worker_status_snapshot()}
    finally:
        _request_gate.release()


@app.post('/v1/chat/completions')
async def chat_completions(request: Request):
    # Retrying clients must not stack overlapping prefills on shared GPU memory.
    if _request_gate.locked():
        return JSONResponse({'ok': False, 'error': {
            'message': 'A model request is already active. Wait for it to finish or use Stop & release GPU.',
            'type': 'server_error', 'code': 'server_busy'}}, status_code=200)
    await _request_gate.acquire()
    _state.update(reply_updates=0, request_aborted=False)
    activity.start(_state)
    request_body = {}
    verified_settings = {}
    verification_config = None
    stream_done = False
    finished = False

    async def finish(aborted=False):
        nonlocal finished
        if finished:
            return
        finished = True
        activity.finish(_state, aborted or _state.get("request_aborted", False))
        if (_state.get('answer_chars', 0) > 0 and _state.get('finish_reason')
                and _state.get('request_result', {}).get('status') == 'completed'
                and (not request_body.get('stream') or stream_done)):
            try:
                from .hf_catalog import record_verified
                entry = next((m for m in verification_config.models if m.id == _state.get('loaded_model_id')), None)
                if entry:
                    record_verified(entry, verification_config, _state.get('device'), _state.get('kv_cache_precision'), verified_settings)
            except Exception:
                log.exception('Could not persist model verification')
        try:
            # Starlette cancels streaming tasks on disconnect. Shield actual native cleanup.
            with anyio.CancelScope(shield=True):
                if (aborted or _state.get('request_aborted') or not _keep_model_loaded()) and _state.get('pipe') is not None:
                    await asyncio.to_thread(unload_pipeline_sync)
        finally:
            _state['generating'] = False
            _request_gate.release()

    try:
        try:
            request_body = await request.json() if request is not None else {}
        except (ValueError, TypeError):
            request_body = {}
        if not isinstance(request_body, dict):
            request_body = {}
        verified_settings = {k: request_body[k] for k in ('max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'repetition_penalty', 'chat_template_kwargs') if k in request_body} if isinstance(request_body, dict) else {}
        verification_config = load_config()
        response = await _chat_completions_impl(request)
    except BaseException:
        await finish(aborted=True)
        raise
    if isinstance(response, StreamingResponse):
        iterator = response.body_iterator
        async def tracked_stream():
            nonlocal stream_done
            complete = False
            try:
                async for chunk in iterator:
                    # OpenAI clients often close as soon as the terminal SSE frame arrives.
                    frame = chunk.decode(errors='replace') if isinstance(chunk, bytes) else chunk
                    activity.frame(_state, frame)
                    if 'data: [DONE]' in frame:
                        stream_done = True
                        complete = True
                    yield chunk
                complete = True
            finally:
                with anyio.CancelScope(shield=True):
                    await iterator.aclose()
                    await finish(aborted=not complete)
        response.body_iterator = tracked_stream()
    else:
        try:
            activity.result(_state, json.loads(response.body))
        except (ValueError, TypeError, AttributeError):
            activity.fail(_state, 'Backend returned an unreadable response.')
        await finish()
    return response
