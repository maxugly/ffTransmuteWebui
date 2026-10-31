"""Run the installed Playground OVMS, retaining its native chat/tool processing.

Launch profile recovered from installed app.asar dist/main/main.js,
startOvmsLlmServer / buildOvmsEnv (2026-10-23). Additional scheduler controls
are the installed OVMS CLI defaults. The WebUI worker remains the cold facade.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import socket
import threading
import time
import urllib.request
from pathlib import Path

import httpx
from fastapi.responses import JSONResponse, StreamingResponse

from .. import shell

log = logging.getLogger("vinoapi.ovms")


def build_launch(cfg, entry, model_dir: Path, device: str, kv: str, port: int):
    root = Path(cfg.runtime.runtime_overlay_path).expanduser().resolve()
    exe = root / "bin/ovms"
    if not exe.is_file():
        raise RuntimeError(f"Playground OVMS executable not found: {exe}")
    from .profiles import effective_runtime
    rt = effective_runtime(cfg, entry)
    argv = [str(exe), "--rest_bind_address", "127.0.0.1", "--rest_port", str(port),
            "--rest_workers", str(rt.ovms_rest_workers), "--source_model", model_dir.name,
            "--model_repository_path", str(model_dir.parent), "--model_name", entry.id,
            "--target_device", device, "--task", "text_generation",
            "--tool_parser", entry.tool_parser, "--reasoning_parser", rt.ovms_reasoning_parser,
            "--cache_dir", str(Path(rt.cache_dir).expanduser().resolve()),
            "--cache_size", str(rt.ovms_cache_size_gb),
            "--max_num_seqs", str(rt.ovms_max_num_seqs),
            "--enable_prefix_caching", str(rt.ovms_enable_prefix_caching).lower(),
            "--dynamic_split_fuse", str(rt.ovms_dynamic_split_fuse).lower()]
    if kv and kv != "auto":
        argv += ["--kv_cache_precision", kv]
    if device.startswith("NPU"):
        argv += ["--max_prompt_len", str(entry.context_window)]
    if rt.ovms_max_num_batched_tokens:
        argv += ["--max_num_batched_tokens", str(rt.ovms_max_num_batched_tokens)]
    # Match Playground's environment isolation, not the facade's Python venv.
    env = {k: v for k, v in os.environ.items() if k not in {
        "VIRTUAL_ENV", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PYTHONEXECUTABLE", "__PYVENV_LAUNCHER__"}}
    paths = [p for p in env.get("PATH", "").split(os.pathsep)
             if not (Path(p).name in {"bin", "Scripts"} and Path(p).parent.name in {"venv", ".venv"})]
    env["PATH"] = os.pathsep.join([str(root / "bin"), str(root), *paths])
    env["OVMS_DIR"] = str(root)
    env["PYTHONPATH"] = str(root / "lib/python")
    libs = [str(root / "lib")]
    uv_python = Path.home() / ".local/share/uv/python"
    for home in [uv_python / "cpython-3.12-linux-x86_64-gnu", *sorted(uv_python.glob("cpython-3.12.*-linux-x86_64-gnu"), reverse=True)]:
        if (home / "lib/libpython3.12.so.1.0").exists():
            env["PYTHONHOME"] = str(home.resolve())
            libs.append(str(home.resolve() / "lib"))
            break
    env["LD_LIBRARY_PATH"] = os.pathsep.join([*libs, env.get("LD_LIBRARY_PATH", "")])
    env["LANG"] = env.get("LANG", "C.UTF-8")
    env["LC_ALL"] = env.get("LC_ALL", env["LANG"])
    return argv, env, str(root)


class PlaygroundRuntime:
    def __init__(self, cfg, entry, model_dir, device, kv):
        self.proc = None
        self.error = None
        self.exit_code = None
        self.spawned = threading.Event()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        argv, env, cwd = build_launch(cfg, entry, model_dir.resolve(), device, kv, self.port)
        self.argv = argv
        log.info("Launching installed Playground OVMS: %s", json.dumps(argv))

        def on_spawn(proc):
            self.proc = proc
            self.spawned.set()

        def run():
            try:
                code, _, _ = asyncio.run(shell.run_command(argv, cwd=cwd, env=env, on_spawn=on_spawn, capture_output=False))
                self.exit_code = code
                if code:
                    self.error = f"Playground OVMS exited with code {code}; see worker log"
            except Exception as exc:
                self.error = str(exc)
            finally:
                self.spawned.set()

        self.thread = threading.Thread(target=run, daemon=True, name="playground-ovms")
        self.thread.start()
        try:
            if not self.spawned.wait(10):
                raise RuntimeError("Playground OVMS did not spawn")
            deadline = time.monotonic() + max(120, cfg.timeout_ms / 1000)
            while time.monotonic() < deadline:
                if self.error or not self.thread.is_alive():
                    raise RuntimeError(self.error or "Playground OVMS exited during model loading")
                try:
                    with urllib.request.urlopen(self.base_url + "/v2/health/ready", timeout=1) as response:
                        if response.status == 200:
                            return
                except OSError:
                    time.sleep(.2)
            raise RuntimeError("Timed out waiting for Playground OVMS model readiness")
        except BaseException:
            self.close()
            raise

    @property
    def running(self):
        return self.proc is not None and self.proc.returncode is None and self.thread.is_alive()

    def close(self):
        if self.proc is not None and self.proc.returncode is None:
            try:
                self.proc.terminate()
            except ProcessLookupError:
                pass
            self.thread.join(2)
            if self.proc.returncode is None:
                try:
                    self.proc.kill()
                except ProcessLookupError:
                    pass
                self.thread.join(5)
            if self.thread.is_alive():
                raise RuntimeError("Previous Playground OVMS has not exited; refusing to stack another model")


def request_payload(body, entry):
    payload = dict(body)
    payload["model"] = entry.id
    for key in ('temperature', 'top_p', 'top_k', 'repetition_penalty'):
        default = getattr(entry, key + '_default')
        if default is not None:
            payload.setdefault(key, default)
    requested = payload.pop("max_completion_tokens", None)
    requested = payload.get("max_tokens", requested)
    payload["max_tokens"] = min(max(1, int(requested if requested is not None else entry.max_tokens_default)), entry.max_tokens)
    from .profiles import supports_thinking
    if supports_thinking(entry):
        thinking = payload.pop("enable_thinking", entry.enable_thinking_default)
        kwargs = dict(payload.get("chat_template_kwargs") or {})
        kwargs.setdefault("enable_thinking", bool(thinking))
        payload["chat_template_kwargs"] = kwargs
    # Keep native messages, tools, tool_choice, and tool_calls intact.
    return payload


class ContextBudgetError(ValueError):
    pass


def fit_context_budget(payload, error_text, entry):
    """Use OVMS's exact post-template token count; never estimate or trim input.

    A context rejection occurs before generation. Retry it once with a smaller
    output allowance, keeping native messages/tools/images entirely intact.
    """
    match = re.search(
        r"Number of prompt tokens:\s*(\d+)(?:\s*\+\s*max tokens value:\s*\d+)?\s*"
        r"exceeds model max length:\s*(\d+)", error_text,
    )
    if not match:
        return None
    prompt_tokens, native_limit = map(int, match.groups())
    limit = min(native_limit, entry.context_window)
    remaining = limit - prompt_tokens
    if remaining < 1:
        raise ContextBudgetError(
            f"The prompt uses {prompt_tokens} tokens; {entry.id} allows {limit} total "
            "and needs space for a reply. Shorten Cline's instructions/history or "
            "choose a model with a larger context. No prompt content was removed."
        )
    if remaining >= payload["max_tokens"]:
        return None
    log.info("Context budget: capping reply from %d to %d tokens (prompt=%d, context=%d)",
             payload["max_tokens"], remaining, prompt_tokens, limit)
    return {**payload, "max_tokens": remaining}


def context_error(exc):
    return {"ok": False, "error": {"message": str(exc), "type": "invalid_request_error",
                                   "code": "context_length_exceeded", "param": "messages"}}


async def chat(runtime, body, cfg, entry, state, request=None):
    try:
        payload = request_payload(body, entry)
    except (ValueError, TypeError) as exc:
        return JSONResponse({"error": {"message": str(exc)}}, status_code=200)
    messages = payload.get('messages') if isinstance(payload.get('messages'), list) else []
    text_chars = 0
    for message in messages:
        content = message.get('content') if isinstance(message, dict) else None
        if isinstance(content, str):
            text_chars += len(content)
        elif isinstance(content, list):
            text_chars += sum(len(str(block.get('text') or '')) for block in content if isinstance(block, dict))
    tool_count = len(payload['tools']) if isinstance(payload.get('tools'), list) else 0
    state['request_summary'] = {'messages': len(messages), 'text_chars': text_chars,
                                'tools': tool_count, 'reply_limit': payload['max_tokens']}
    log.info('request %s: input %d messages / %d text characters / %d tools; reply cap %d',
             state.get('request_id', '-'), len(messages), text_chars, tool_count, payload['max_tokens'])
    timeout = max(1, cfg.timeout_ms / 1000)
    url = runtime.base_url + "/v3/chat/completions"
    if not payload.get("stream"):
        state['generating'] = True
        async def execute():
            async with asyncio.timeout(timeout):
                async with httpx.AsyncClient(timeout=timeout) as client:
                    response = await client.post(url, json=payload)
                    retry = fit_context_budget(payload, response.text, entry) if response.is_error else None
                    if retry is not None:
                        response = await client.post(url, json=retry)
                    return JSONResponse(response.json(), status_code=200)
        async def disconnected():
            while not await request.is_disconnected():
                await asyncio.sleep(.25)
        operation = asyncio.create_task(execute())
        watcher = asyncio.create_task(disconnected()) if request is not None else None
        try:
            if watcher is not None:
                done, _ = await asyncio.wait([operation, watcher], return_when=asyncio.FIRST_COMPLETED)
                if watcher in done:
                    state['request_aborted'] = True
                    operation.cancel()
                    return JSONResponse({'ok': False, 'error': {'message': 'Client disconnected; generation stopped.', 'code': 'request_cancelled'}})
            return await operation
        except ContextBudgetError as exc:
            return JSONResponse(context_error(exc), status_code=200)
        except Exception as exc:
            state['request_aborted'] = True
            message = f'Request exceeded {timeout:g}s; model unloaded. Reduce context/reply length or increase Request time limit.' if isinstance(exc, TimeoutError) else str(exc)
            return JSONResponse({'ok': False, 'error': {'message': message, 'type': 'server_error'}}, status_code=200)
        finally:
            operation.cancel()
            if watcher is not None:
                watcher.cancel()
            await asyncio.gather(operation, *([watcher] if watcher is not None else []), return_exceptions=True)
            state['generating'] = False

    async def stream():
        queue = asyncio.Queue(maxsize=64)

        async def pump_native():
            state["generating"] = True
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    outgoing = payload
                    for attempt in range(2):
                        async with client.stream("POST", url, json=outgoing) as response:
                            if response.is_error:
                                error = (await response.aread()).decode(errors="replace")
                                retry = fit_context_budget(outgoing, error, entry) if attempt == 0 else None
                                if retry is not None:
                                    outgoing = retry
                                    continue
                                await queue.put(f"data: {json.dumps({'error': {'message': error}})}\n\n")
                                await queue.put("data: [DONE]\n\n")
                            else:
                                async for line in response.aiter_lines():
                                    if line:
                                        if line.startswith('data: ') and line[6:] != '[DONE]':
                                            try:
                                                data = json.loads(line[6:])
                                                if any(c.get('delta', {}).get(k) for c in data.get('choices', []) for k in ('content', 'reasoning_content', 'tool_calls')):
                                                    state['reply_updates'] = state.get('reply_updates', 0) + 1
                                                    state['last_reply_at'] = time.monotonic()
                                            except (ValueError, TypeError):
                                                pass
                                        await queue.put(line + "\n\n")
                            break
            except ContextBudgetError as exc:
                await queue.put(f"data: {json.dumps(context_error(exc))}\n\n")
                await queue.put("data: [DONE]\n\n")
            except Exception as exc:
                state['request_aborted'] = True
                await queue.put(f"data: {json.dumps({'error': {'message': str(exc)}})}\n\n")
                await queue.put("data: [DONE]\n\n")
            finally:
                state["generating"] = False
                if not asyncio.current_task().cancelling():
                    await queue.put(None)

        async def pump():
            try:
                async with asyncio.timeout(timeout):
                    await pump_native()
            except TimeoutError:
                state['request_aborted'] = True
                state['generating'] = False
                await queue.put(f"data: {json.dumps({'ok': False, 'error': {'message': f'Request exceeded {timeout:g}s; model unloaded. Reduce context/reply length or increase Request time limit.', 'code': 'request_timeout'}})}\n\n")
                await queue.put('data: [DONE]\n\n')
                await queue.put(None)

        task = asyncio.create_task(pump())
        try:
            yield ": connecting-playground-ovms\n\n"
            while True:
                try:
                    interval = cfg.runtime.sse_keepalive_interval_s if cfg.runtime.enable_sse_keepalive else None
                    piece = await asyncio.wait_for(queue.get(), timeout=interval)
                except asyncio.TimeoutError:
                    yield ": prefill-keepalive\n\n"
                    continue
                if piece is None:
                    break
                yield piece
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
