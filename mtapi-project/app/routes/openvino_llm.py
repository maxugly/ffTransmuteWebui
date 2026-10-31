"""HTTP routes for the OpenVINO Local LLM Server tab (`/admin/*` and `/api/openvino/*`).

All operational / validation errors answer HTTP 200 + `{"ok": False, "error": "..."}`
per `AGENTS.md` Invariant 10.

Spec: docs/openvino-tab-spec.md §8
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, FastAPI, Request

from ..openvino_llm.config import (
    build_v1_model_card,
    build_v1_models_payload,
    load_config,
)
from ..openvino_llm.supervisor import get_supervisor
from ..openvino_llm.catalog import model_catalog, start_download


async def _read_json_body(request: Request) -> tuple[dict[str, Any] | None, str | None]:
    """Read optional JSON body without letting FastAPI emit a 422 on bad shapes."""
    try:
        raw = await request.body()
    except Exception as exc:
        return None, f"Failed to read request body: {exc}"
    if not raw or not raw.strip():
        return {}, None
    try:
        parsed = json.loads(raw)
    except Exception as exc:
        return None, f"Invalid JSON body: {exc}"
    if not isinstance(parsed, dict):
        return None, "Request body must be a JSON object"
    return parsed, None


def register(app: FastAPI) -> None:
    router = APIRouter(tags=["openvino"])

    @router.get("/api/openvino/models")
    def playground_models():
        try:
            return model_catalog()
        except Exception as exc:
            return {"ok": False, "error": f"Cannot read Playground model catalog: {exc}"}

    @router.post('/api/openvino/models/refresh')
    async def refresh_models(request: Request):
        from ..openvino_llm.hf_catalog import start_refresh
        body, error = await _read_json_body(request)
        if error:
            return {'ok': False, 'error': error}
        return start_refresh(force=bool(body.get('force', False)))

    @router.post('/api/openvino/models/download/cancel')
    def cancel_model_download():
        from ..openvino_llm.catalog import cancel_download
        return cancel_download()

    @router.post("/api/openvino/models/download")
    async def playground_model_download(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        try:
            return start_download(str(body.get("model_id") or ""))
        except Exception as exc:
            return {"ok": False, "error": f"Cannot start model download: {exc}"}

    @router.get('/api/openvino/model-settings')
    def model_settings(model_id: str = '', engine: str = 'playground', device: str = 'GPU'):
        from ..openvino_llm.profiles import resolve_model, describe, presets
        try:
            if engine not in {'playground', 'genai'}:
                raise ValueError('Unknown engine')
            _, entry = resolve_model(model_id)
            descriptor = describe(entry, engine, device)
            descriptor.update(presets(descriptor))
            return descriptor
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}

    @router.post('/api/openvino/presets')
    async def save_model_preset(request: Request):
        from ..openvino_llm.profiles import resolve_model, describe, presets
        body, err = await _read_json_body(request)
        if err or body is None:
            return {'ok': False, 'error': err}
        try:
            _, entry = resolve_model(str(body.get('model_id') or ''))
            engine = body.get('engine', 'playground')
            if engine not in {'playground', 'genai'}:
                raise ValueError('Unknown engine')
            values = body.get('values') or {}
            descriptor = describe(entry, engine, values.get('runtime', {}).get('device', 'GPU'))
            return presets(descriptor, name=body.get('name', ''), values=values,
                           delete=bool(body.get('delete')), overwrite=bool(body.get('overwrite')))
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}

    @router.get("/admin/status")
    @router.get("/api/openvino/status")
    @router.get("/api/openvino/admin/status")
    async def admin_status():
        return await get_supervisor().status()

    @router.post("/admin/start")
    @router.post("/api/openvino/start")
    @router.post("/api/openvino/admin/start")
    async def admin_start(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        auto_load = body.get("auto_load") if "auto_load" in body else None
        kill_stray = bool(body.get("kill_stray", True))
        return await get_supervisor().start(auto_load=auto_load, kill_stray=kill_stray)

    @router.post("/admin/kill-stray")
    @router.post("/api/openvino/kill-stray")
    @router.post("/api/openvino/admin/kill-stray")
    async def admin_kill_stray(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        include_ovms = bool(body.get("include_ovms", False))
        raw_pids = body.get("pids")
        target_pids = (
            [int(p) for p in raw_pids if str(p).isdigit()]
            if isinstance(raw_pids, list)
            else None
        )
        return await get_supervisor().kill_stray(
            include_ovms=include_ovms,
            target_pids=target_pids,
        )

    @router.post("/admin/stop")
    @router.post("/api/openvino/stop")
    @router.post("/api/openvino/admin/stop")
    async def admin_stop():
        return await get_supervisor().stop()

    @router.post("/admin/restart")
    @router.post("/api/openvino/restart")
    @router.post("/api/openvino/admin/restart")
    async def admin_restart(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        re_warm = body.get("re_warm") if "re_warm" in body else None
        return await get_supervisor().restart(re_warm=re_warm)

    @router.post("/admin/load")
    @router.post("/api/openvino/load")
    @router.post("/api/openvino/admin/load")
    async def admin_load(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        return await get_supervisor().load_model(
            model_id=body.get("model_id"),
            model_path=body.get("model_path"),
            device=body.get("device"),
            kv_cache_precision=body.get("kv_cache_precision"),
        )

    @router.post("/admin/unload")
    @router.post("/api/openvino/unload")
    @router.post("/api/openvino/admin/unload")
    async def admin_unload():
        return await get_supervisor().unload_model()

    @router.get("/admin/config")
    @router.get("/api/openvino/config")
    @router.get("/api/openvino/admin/config")
    async def admin_get_config():
        cfg = load_config()
        return {"ok": True, "config": cfg.model_dump(mode="json")}

    @router.post("/admin/config")
    @router.post("/api/openvino/config")
    @router.post("/api/openvino/admin/config")
    async def admin_save_config(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        restart = bool(body.get("restart", True))
        payload = body.get("config") if isinstance(body.get("config"), dict) else body
        return await get_supervisor().update_config(payload, restart=restart)

    @router.post('/api/openvino/test/stream')
    async def stream_test(request: Request):
        import httpx
        from fastapi.responses import StreamingResponse
        body, error = await _read_json_body(request)
        if error or body is None:
            return {'ok': False, 'error': error}
        cfg = load_config()
        if not (await get_supervisor().status())['server']['running']:
            return {'ok': False, 'error': 'API stopped. Click Load Model to start it before sending a test.'}
        try:
            limit = max(1, min(int(body.get('max_tokens', 64)), 2048))
        except (TypeError, ValueError):
            return {'ok': False, 'error': 'Reply tokens must be an integer'}
        payload = {'model': cfg.active_model_id, 'messages': [{'role': 'user', 'content': str(body.get('prompt') or 'Reply OK.')}],
                   'max_tokens': limit, 'stream': True, 'stream_options': {'include_usage': True}}
        async def relay():
            yield ': test connected; waiting for model output\n\n'
            try:
                async with httpx.AsyncClient(timeout=max(30, cfg.timeout_ms / 1000 + 15)) as client:
                    async with client.stream('POST', f'http://{cfg.host}:{cfg.port}/v1/chat/completions',
                                             json=payload, headers={'Authorization': f'Bearer {cfg.api_key}'}) as response:
                        if 'text/event-stream' not in response.headers.get('content-type', ''):
                            raw = await response.aread()
                            try:
                                result = json.loads(raw)
                            except ValueError:
                                result = {'error': {'message': raw.decode(errors='replace') or 'No readable response'}}
                            yield f'data: {json.dumps(result)}\n\n'
                            yield 'data: [DONE]\n\n'
                        else:
                            async for chunk in response.aiter_bytes():
                                yield chunk
            except Exception as exc:
                yield f'data: {json.dumps({"error": {"message": str(exc) or "Connection to model failed"}})}\n\n'
                yield 'data: [DONE]\n\n'
        return StreamingResponse(relay(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache'})

    @router.post("/admin/test")
    @router.post("/api/openvino/test")
    async def admin_test_chat(request: Request):
        body, err = await _read_json_body(request)
        if err or body is None:
            return {"ok": False, "error": err or "Invalid body"}
        prompt = str(body.get("prompt") or "Say hello in one short sentence.").strip()
        try:
            max_tokens = int(body.get("max_tokens") or 128)
        except (TypeError, ValueError):
            max_tokens = 128
        return await get_supervisor().test_chat(prompt=prompt, max_tokens=max_tokens)

    @router.get("/v1/models")
    async def v1_models():
        cfg = load_config()
        st = await get_supervisor().status()
        loaded_id = (st.get("model") or {}).get("loaded_model_id")
        return build_v1_models_payload(cfg, loaded_model_id=loaded_id)

    @router.get("/v1/models/{model_id:path}")
    async def v1_model_detail(model_id: str):
        cfg = load_config()
        st = await get_supervisor().status()
        loaded_id = (st.get("model") or {}).get("loaded_model_id")
        entry = cfg.find_model(model_id)
        return build_v1_model_card(entry, cfg, loaded_model_id=loaded_id)

    app.include_router(router)
