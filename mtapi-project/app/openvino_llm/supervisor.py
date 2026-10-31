"""Supervisor for the OpenVINO GenAI worker process (Level-1 Server Up/Down + Level-2 Model Hot/Cold proxy).

All process launches go through `asyncio.create_subprocess_exec` with argv lists
built by `app.openvino_llm.cage.CageLauncher` (AGENTS.md Invariant 2: no shell=True).

Spec: docs/openvino-tab-spec.md §2, §5, §8.1
"""
from __future__ import annotations

import asyncio
from collections import deque
import json
import logging
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .. import model_hot
from .cage import (
    detect_orphaned_ovms,
    detect_stray_processes,
    kill_stray_processes,
    mem_available_mb,
    process_rss_mb,
    resolve_launcher,
)
from .config import (
    PROJECT_ROOT,
    OpenVinoSettings,
    load_config,
    save_config,
    settings_path,
    validate_and_merge_config,
)

log = logging.getLogger("mtapi.openvino")


def _timestamp() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _is_port_open(host: str, port: int, timeout: float = 0.25) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def _http_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 10.0,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req_headers = {"Accept": "application/json"}
    if data is not None:
        req_headers["Content-Type"] = "application/json"
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw) if raw else {"error": str(exc)}
        except Exception:
            parsed = {"error": str(exc)}
        return exc.code, parsed


class OpenVinoSupervisor:
    """Manages the caged OpenVINO uvicorn worker and proxies model hot/cold controls."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._proc: asyncio.subprocess.Process | None = None
        self._server_state: str = "down"  # "down" | "starting" | "up" | "stopping" | "crashed"
        self._started_at: float | None = None
        self._active_cage_meta: dict[str, Any] | None = None
        self._last_exit_code: int | None = None
        self._last_error: str | None = None
        self._stopping_intentionally: bool = False
        self._logs: deque[str] = deque(maxlen=250)
        self._hot_key: str | None = None
        self._cached_model_snap: dict[str, Any] = self._cold_model_snapshot()

    def _log_line(self, msg: str) -> None:
        line = f"{_timestamp()} {msg}"
        self._logs.append(line)
        log.info("%s", msg)

    def _cold_model_snapshot(self, cfg: OpenVinoSettings | None = None) -> dict[str, Any]:
        c = cfg or load_config()
        avail, total = mem_available_mb()
        return {
            "state": "cold",
            "hot": False,
            "loaded_model_id": None,
            "loaded_model_path": None,
            "device": c.runtime.device,
            "kv_cache_precision": c.runtime.kv_cache_precision,
            "load_duration_s": None,
            "generating": False,
            "keep_loaded": model_hot.enabled("openvino"),
            "process_rss_mb": process_rss_mb(self._proc.pid) if self._proc and self._proc.returncode is None else 0,
            "model_mem_used_mb": 0,
            "mem_available_mb": avail,
            "mem_total_mb": total,
            "preflight_min_mb": c.runtime.preflight_min_mb,
            "last_error": None,
        }

    def _sync_global_model_hot(self, model_snap: dict[str, Any], cfg: OpenVinoSettings) -> None:
        """Keep `app/model_hot.py` synchronized with the worker's Level-2 state."""
        if model_snap.get("status_unavailable"):
            return
        mstate = model_snap.get("state", "cold")
        model_id = model_snap.get("loaded_model_id") or cfg.active_model_id
        model_path = model_snap.get("loaded_model_path") or cfg.runtime.model_path
        paths = [model_path] if model_path else []

        if mstate == "loading":
            if not self._hot_key:
                self._hot_key = model_hot.start_loading("openvino", model_id, paths=paths)
        elif mstate == "hot":
            if not self._hot_key:
                self._hot_key = model_hot.start_loading("openvino", model_id, paths=paths)
            model_hot.loaded(self._hot_key)
        else:
            if self._hot_key:
                model_hot.forget(self._hot_key)
                self._hot_key = None

    def build_worker_env_and_argv(
        self,
        cfg: OpenVinoSettings,
        auto_load: bool = False,
    ) -> tuple[list[str], dict[str, str], str]:
        """Build the caged argv list and environment dict for the worker subprocess."""
        venv_py = PROJECT_ROOT / ".venv" / "bin" / "python"
        python_exe = str(venv_py) if venv_py.is_file() else sys.executable

        keep_alive_s = max(65, int(cfg.timeout_ms // 1000))
        target_argv = [
            python_exe,
            "-m",
            "uvicorn",
            "app.openvino_llm.worker:app",
            "--host",
            cfg.host,
            "--port",
            str(cfg.port),
            "--timeout-keep-alive",
            str(keep_alive_s),
        ]

        launcher = resolve_launcher(cfg.cage.backend)
        caged_argv = launcher.build_argv(target_argv, cfg.cage)

        env = dict(os.environ)
        env["MTAPI_OPENVINO_SETTINGS"] = str(settings_path())
        env["VINO_HOST"] = cfg.host
        env["VINO_PORT"] = str(cfg.port)
        env["VINO_RSS_CAP_MB"] = str(cfg.cage.rss_cap_mb)
        env["VINO_OOM_SCORE_ADJUST"] = str(cfg.cage.oom_score_adjust)
        env["VINO_WATCHDOG_FLOOR"] = "on" if cfg.cage.watchdog_floor_enabled else "off"
        env["VINO_AUTO_LOAD_ON_START"] = "1" if auto_load else "0"
        if cfg.runtime.cache_dir:
            env["GPU_PLUGIN_CACHE_DIR"] = cfg.runtime.cache_dir

        # Construct PYTHONPATH: optional runtime_overlay_path first (for pre-compiled .blob cache hits),
        # then PROJECT_ROOT and .venv site-packages.
        py_paths: list[str] = []
        ld_paths: list[str] = []

        overlay = (cfg.runtime.runtime_overlay_path or "").strip()
        if overlay:
            ov_root = Path(overlay).expanduser()
            ov_py = ov_root / "lib" / "python"
            ov_lib = ov_root / "lib"
            if ov_py.is_dir():
                py_paths.append(str(ov_py))
            if ov_lib.is_dir():
                ld_paths.append(str(ov_lib))

        py_paths.append(str(PROJECT_ROOT))
        for sp in sorted((PROJECT_ROOT / ".venv" / "lib").glob("python*/site-packages")):
            if sp.is_dir():
                py_paths.append(str(sp))

        if env.get("PYTHONPATH"):
            py_paths.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(py_paths)

        if ld_paths:
            if env.get("LD_LIBRARY_PATH"):
                ld_paths.append(env["LD_LIBRARY_PATH"])
            env["LD_LIBRARY_PATH"] = os.pathsep.join(ld_paths)

        return caged_argv, env, launcher.id

    async def _stream_pipe(self, stream: asyncio.StreamReader | None, label: str) -> None:
        if stream is None:
            return
        while True:
            line_b = await stream.readline()
            if not line_b:
                break
            text = line_b.decode("utf-8", errors="replace").rstrip("\r\n")
            if text.strip() and not ('GET /internal/status HTTP/' in text and '200 OK' in text):
                self._log_line(f"[{label}] {text}")

    async def _watch_process(self, proc: asyncio.subprocess.Process) -> None:
        rc = await proc.wait()
        self._last_exit_code = rc
        self._sync_global_model_hot({"state": "cold"}, load_config())
        if self._proc is proc:
            self._proc = None
            self._started_at = None
            if self._stopping_intentionally:
                self._server_state = "down"
                self._log_line(f"[supervisor] Worker stopped cleanly (exit={rc})")
            else:
                self._server_state = "crashed"
                if rc in (137, -9):
                    reason = (
                        "Worker killed by kernel OOM killer inside memory cage "
                        "(exit 137 / SIGKILL) — desktop protected."
                    )
                elif rc == 4:
                    reason = (
                        "Worker aborted by self-RSS watchdog (exit 4: RSS exceeded cap — "
                        "probable cache miss / GPU recompile)."
                    )
                elif rc == 3:
                    reason = "Worker aborted by MemAvailable floor watchdog (exit 3)."
                else:
                    reason = f"Worker exited unexpectedly with code {rc}."
                self._last_error = reason
                self._log_line(f"[supervisor] ERROR: {reason}")

    async def _query_worker_status(self, cfg: OpenVinoSettings) -> dict[str, Any] | None:
        url = f"http://{cfg.host}:{cfg.port}/internal/status"
        try:
            code, data = await asyncio.to_thread(_http_json, "GET", url, None, 2.0)
            if code == 200 and isinstance(data, dict) and data.get("ok"):
                return data
        except Exception:
            pass
        return None

    async def status(self) -> dict[str, Any]:
        cfg = load_config()
        running = self._proc is not None and self._proc.returncode is None
        pid = self._proc.pid if running and self._proc else None
        uptime_s = (
            round(max(0.0, time.time() - self._started_at), 1)
            if running and self._started_at
            else 0.0
        )

        model_snap = self._cold_model_snapshot(cfg)
        if running:
            w_status = await self._query_worker_status(cfg)
            if w_status and isinstance(w_status.get("model"), dict):
                model_snap.update(w_status["model"])
                model_snap["preflight_min_mb"] = cfg.runtime.preflight_min_mb
                self._cached_model_snap = model_snap
                if self._server_state == "starting":
                    self._server_state = "up"
            else:
                model_snap.update(self._cached_model_snap)
                model_snap['status_unavailable'] = True
                model_snap['activity'] = {'phase': 'unknown', 'detail': 'Cannot read model status. The API process exists, but model progress cannot be confirmed.', 'elapsed_s': 0}
                model_snap["process_rss_mb"] = process_rss_mb(pid)
        else:
            if self._server_state in ("up", "starting", "stopping"):
                self._server_state = "down"

        self._sync_global_model_hot(model_snap, cfg)

        launcher = resolve_launcher(cfg.cage.backend)
        cage_info = self._active_cage_meta or {
            "backend": launcher.id,
            "configured_backend": cfg.cage.backend,
            "memory_max": cfg.cage.memory_max,
            "memory_high": cfg.cage.memory_high,
            "memory_swap_max": cfg.cage.memory_swap_max,
            "oom_score_adjust": cfg.cage.oom_score_adjust,
            "rss_cap_mb": cfg.cage.rss_cap_mb,
            "watchdog_floor_enabled": cfg.cage.watchdog_floor_enabled,
        }

        orphans = detect_orphaned_ovms(exclude_pid=pid)
        strays = detect_stray_processes(cfg.port, exclude_pid=pid)
        port_conflict = next((s for s in strays if s.get("holds_port")), None) if not running else None

        return {
            "ok": True,
            "server": {
                "state": self._server_state,
                "running": running,
                "pid": pid,
                "uptime_s": uptime_s,
                "host": cfg.host,
                "port": cfg.port,
                "base_url": cfg.base_url,
                "model_source_url": cfg.model_source_url,
                "cage": cage_info,
                "last_exit_code": self._last_exit_code,
                "last_error": self._last_error,
                "orphaned_ovms": orphans,
                "stray_processes": strays,
                "port_conflict": port_conflict,
            },
            "model": model_snap,
            "config": cfg.model_dump(mode="json"),
            "logs": list(self._logs)[-80:],
        }

    async def kill_stray(
        self,
        include_ovms: bool = False,
        target_pids: list[int] | None = None,
    ) -> dict[str, Any]:
        """Kill stray `vinoapi`/worker/port-holder processes (and optionally orphaned `ovms`)."""
        cfg = load_config()
        running = self._proc is not None and self._proc.returncode is None
        pid = self._proc.pid if running and self._proc else None

        res = await asyncio.to_thread(
            kill_stray_processes,
            cfg.port,
            pid,
            include_ovms,
            target_pids,
        )
        killed = res.get("killed", [])
        errors = res.get("errors", [])
        if killed:
            summary = ", ".join(
                f"PID {k['pid']} ({k['kind']}, {k['rss_mb']}MB, {k.get('signal', 'SIGTERM')})"
                for k in killed
            )
            self._log_line(f"[supervisor] Killed stray process(es): {summary}")
        else:
            self._log_line(f"[supervisor] No stray processes found on port {cfg.port}.")

        if self._last_error and "already in use" in self._last_error:
            self._last_error = None

        snap = await self.status()
        snap["ok"] = bool(res.get("ok", True))
        snap["killed"] = killed
        if errors:
            snap["ok"] = False
            snap["error"] = "; ".join(errors)
        return snap

    async def start(
        self,
        auto_load: bool | None = None,
        kill_stray: bool = True,
    ) -> dict[str, Any]:
        async with self._lock:
            cfg = load_config()
            if self._proc is not None and self._proc.returncode is None:
                snap = await self.status()
                snap["already_running"] = True
                return snap

            if _is_port_open(cfg.host, cfg.port):
                if kill_stray:
                    res = await asyncio.to_thread(kill_stray_processes, cfg.port, None, False)
                    killed = res.get("killed", [])
                    if killed:
                        pids_txt = ", ".join(f"PID {k['pid']} ({k['kind']})" for k in killed)
                        self._log_line(
                            f"[supervisor] Reclaiming port {cfg.port}: terminated stray process(es) {pids_txt}"
                        )
                        for _ in range(25):
                            if not _is_port_open(cfg.host, cfg.port):
                                break
                            await asyncio.sleep(0.1)

                if _is_port_open(cfg.host, cfg.port):
                    strays = detect_stray_processes(cfg.port, exclude_pid=None)
                    holder = next((s for s in strays if s.get("holds_port")), None)
                    holder_desc = (
                        f" (held by PID {holder['pid']}: {holder['cmdline']})"
                        if holder
                        else ""
                    )
                    err = (
                        f"Port {cfg.port} on {cfg.host} is already in use by another process{holder_desc}. "
                        "Click 'Kill Stray' or change the Port setting."
                    )
                    self._last_error = err
                    self._log_line(f"[supervisor] Start refused: {err}")
                    snap = await self.status()
                    snap["ok"] = False
                    snap["error"] = err
                    return snap

            should_auto_load = (
                bool(auto_load)
                if auto_load is not None
                else bool(cfg.runtime.auto_load_on_start)
            )
            caged_argv, env, resolved_backend = self.build_worker_env_and_argv(
                cfg, auto_load=False
            )

            self._stopping_intentionally = False
            self._server_state = "starting"
            self._last_error = None
            self._last_exit_code = None
            self._log_line(
                f"[supervisor] Launching caged uvicorn on {cfg.host}:{cfg.port} "
                f"({resolved_backend}: MemoryMax={cfg.cage.memory_max}, "
                f"MemoryHigh={cfg.cage.memory_high}, MemorySwapMax={cfg.cage.memory_swap_max}, "
                f"OOMScoreAdjust={cfg.cage.oom_score_adjust})"
            )

            try:
                proc = await asyncio.create_subprocess_exec(
                    *caged_argv,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=str(PROJECT_ROOT),
                    env=env,
                )
            except Exception as exc:
                self._server_state = "crashed"
                self._last_error = f"Failed to spawn worker: {exc}"
                self._log_line(f"[supervisor] ERROR: {self._last_error}")
                snap = await self.status()
                snap["ok"] = False
                snap["error"] = self._last_error
                return snap

            self._proc = proc
            self._started_at = time.time()
            launcher = resolve_launcher(cfg.cage.backend)
            self._active_cage_meta = launcher.post_spawn(proc.pid, cfg.cage)

            asyncio.create_task(self._stream_pipe(proc.stdout, "vinoapi"))
            asyncio.create_task(self._stream_pipe(proc.stderr, "vinoapi"))
            asyncio.create_task(self._watch_process(proc))

            # Poll /health until listening (up to 10s)
            health_url = f"http://{cfg.host}:{cfg.port}/health"
            ready = False
            for _ in range(50):
                if proc.returncode is not None:
                    break
                try:
                    code, _ = await asyncio.to_thread(_http_json, "GET", health_url, None, 0.5)
                    if code == 200:
                        ready = True
                        break
                except Exception:
                    pass
                await asyncio.sleep(0.2)

            if not ready:
                if proc.returncode is None:
                    try:
                        proc.terminate()
                        await asyncio.wait_for(proc.wait(), timeout=2.0)
                    except Exception:
                        pass
                err = self._last_error or f"Worker failed to bind {cfg.host}:{cfg.port} within 10s"
                self._server_state = "crashed"
                self._last_error = err
                snap = await self.status()
                snap["ok"] = False
                snap["error"] = err
                return snap

            self._server_state = "up"
            self._log_line(f"[supervisor] Server UP on {cfg.host}:{cfg.port} (PID {proc.pid}, Model Cold)")

        if should_auto_load:
            return await self.load_model()
        return await self.status()

    async def stop(self) -> dict[str, Any]:
        async with self._lock:
            cfg = load_config()
            if self._proc is None or self._proc.returncode is not None:
                self._proc = None
                self._server_state = "down"
                self._sync_global_model_hot({"state": "cold"}, cfg)
                # Also clean up any stray processes holding cfg.port
                res = await asyncio.to_thread(kill_stray_processes, cfg.port, None, False)
                killed = res.get("killed", [])
                if killed:
                    pids_txt = ", ".join(f"PID {k['pid']} ({k['kind']})" for k in killed)
                    self._log_line(f"[supervisor] Stopped stray process(es) on port {cfg.port}: {pids_txt}")
                snap = await self.status()
                snap["already_stopped"] = len(killed) == 0
                snap["killed"] = killed
                return snap

            proc = self._proc
            self._stopping_intentionally = True
            self._server_state = "stopping"
            self._log_line(f"[supervisor] Stopping worker PID {proc.pid}...")

            # Best-effort graceful unload before SIGTERM
            try:
                unload_url = f"http://{cfg.host}:{cfg.port}/internal/unload"
                await asyncio.to_thread(_http_json, "POST", unload_url, {}, 2.0)
            except Exception:
                pass

            try:
                proc.terminate()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    self._log_line(f"[supervisor] Worker PID {proc.pid} did not exit on SIGTERM; sending SIGKILL")
                    proc.kill()
                    await asyncio.wait_for(proc.wait(), timeout=2.0)
            except ProcessLookupError:
                pass
            except Exception as exc:
                self._log_line(f"[supervisor] Stop warning: {exc}")

            self._proc = None
            self._started_at = None
            self._active_cage_meta = None
            self._server_state = "down"
            self._sync_global_model_hot({"state": "cold"}, cfg)
            return await self.status()

    async def load_model(
        self,
        model_id: str | None = None,
        model_path: str | None = None,
        device: str | None = None,
        kv_cache_precision: str | None = None,
    ) -> dict[str, Any]:
        cfg = load_config()
        if self._proc is None or self._proc.returncode is not None:
            snap = await self.status()
            snap["ok"] = False
            snap["error"] = "Server is Down — start the server first before loading a model."
            return snap

        entry = cfg.find_model(model_id)
        target_id = model_id or entry.id
        target_path = model_path or entry.model_path or cfg.runtime.model_path
        from .profiles import effective_runtime
        rt = effective_runtime(cfg, entry)
        target_device = device or rt.device
        target_kv = kv_cache_precision or rt.kv_cache_precision

        self._log_line(
            f"[supervisor] Requesting model load: id={target_id} device={target_device} kv={target_kv}"
        )
        self._sync_global_model_hot(
            {"state": "loading", "loaded_model_id": target_id, "loaded_model_path": target_path},
            cfg,
        )

        url = f"http://{cfg.host}:{cfg.port}/internal/load"
        payload = {
            "model_id": target_id,
            "model_path": target_path,
            "device": target_device,
            "kv_cache_precision": target_kv,
        }
        try:
            code, res = await asyncio.to_thread(_http_json, "POST", url, payload, 300.0)
        except Exception as exc:
            self._sync_global_model_hot({"state": "cold"}, cfg)
            err = f"Worker load request failed: {exc}"
            self._last_error = err
            self._log_line(f"[supervisor] ERROR: {err}")
            snap = await self.status()
            snap["ok"] = False
            snap["error"] = err
            return snap

        snap = await self.status()
        if code != 200 or not res.get("ok"):
            err = res.get("error") or f"Model load failed (HTTP {code})"
            self._last_error = err
            self._log_line(f"[supervisor] Model load refused/failed: {err}")
            snap["ok"] = False
            snap["error"] = err
            return snap

        self._last_error = None
        self._log_line(
            f"[supervisor] Model HOT: {target_id} "
            f"(RSS={snap['model'].get('process_rss_mb')}MB, "
            f"Avail={snap['model'].get('mem_available_mb')}MB)"
        )
        return snap

    async def unload_model(self) -> dict[str, Any]:
        cfg = load_config()
        if self._proc is None or self._proc.returncode is not None:
            snap = await self.status()
            snap["already_cold"] = True
            return snap

        self._log_line("[supervisor] Requesting model unload (Hot -> Cold)...")
        url = f"http://{cfg.host}:{cfg.port}/internal/unload"
        try:
            code, res = await asyncio.to_thread(_http_json, "POST", url, {}, 30.0)
        except Exception as exc:
            err = f"Worker unload request failed: {exc}"
            self._log_line(f"[supervisor] ERROR: {err}")
            snap = await self.status()
            snap["ok"] = False
            snap["error"] = err
            return snap

        snap = await self.status()
        if code != 200 or not res.get("ok"):
            err = res.get("error") or f"Model unload failed (HTTP {code})"
            snap["ok"] = False
            snap["error"] = err
            return snap

        self._log_line(
            f"[supervisor] Model COLD (RSS={snap['model'].get('process_rss_mb')}MB, "
            f"Avail={snap['model'].get('mem_available_mb')}MB)"
        )
        return snap

    async def release_if_idle(self) -> dict[str, Any]:
        """Keep-loaded off releases only idle OpenVINO work, never another tool."""
        if self._proc is None or self._proc.returncode is not None:
            return {'ok': True}
        cfg = load_config()
        try:
            code, result = await asyncio.to_thread(
                _http_json, 'POST', f'http://{cfg.host}:{cfg.port}/internal/release-if-idle', {}, 15.0)
            if code != 200 or not result.get('ok'):
                return {'ok': False, 'error': result.get('error', 'Cannot update model retention')}
            await self.status()
            return result
        except Exception as exc:
            return {'ok': False, 'error': str(exc)}

    async def restart(self, re_warm: bool | None = None) -> dict[str, Any]:
        cur = await self.status()
        was_running = bool(cur["server"]["running"])
        was_hot = bool(cur["model"]["hot"])
        if was_running:
            await self.stop()
        should_warm = re_warm if re_warm is not None else was_hot
        return await self.start(auto_load=should_warm)

    async def update_config(
        self,
        raw: dict[str, Any],
        restart: bool = True,
    ) -> dict[str, Any]:
        try:
            previous = load_config()
            merged = validate_and_merge_config(raw)
            save_config(merged)
        except ValueError as exc:
            snap = await self.status()
            snap["ok"] = False
            snap["error"] = str(exc)
            return snap
        except Exception as exc:
            snap = await self.status()
            snap["ok"] = False
            snap["error"] = f"Failed to save configuration: {exc}"
            return snap

        self._log_line(
            f"[supervisor] Configuration saved (port={merged.port}, "
            f"active_model={merged.active_model_id}, timeout_ms={merged.timeout_ms}, "
            f"cage={merged.cage.memory_max}/{merged.cage.memory_high})"
        )
        is_up = self._proc is not None and self._proc.returncode is None
        # Generation defaults are read per request; restarting would discard warm weights.
        def launch_settings(cfg):
            data = cfg.model_dump(mode='json')
            active = cfg.active_model().model_dump(mode='json')
            # Only the active engine/model controls the resident process.
            data.pop('models', None)
            for key in ('temperature_default', 'top_p_default', 'top_k_default',
                        'repetition_penalty_default', 'max_tokens_default', 'max_tokens',
                        'enable_thinking_default', 'capabilities', 'runtime_profiles'):
                active.pop(key, None)
            data['active_model'] = active
            return data
        if is_up and restart and launch_settings(previous) != launch_settings(merged):
            self._log_line("[supervisor] Restarting server to apply updated configuration...")
            if previous.active_model_id != merged.active_model_id:
                return await self.restart(re_warm=False)
            return await self.restart()
        return await self.status()

    async def test_chat(self, prompt: str, max_tokens: int = 128) -> dict[str, Any]:
        """Run a quick test chat completion against the running worker."""
        cfg = load_config()
        if self._proc is None or self._proc.returncode is not None:
            return {
                "ok": False,
                "error": "Server is Down — click 'Start Server' first.",
            }
        url = f"http://{cfg.host}:{cfg.port}/v1/chat/completions"
        headers: dict[str, str] = {}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        payload = {
            "model": cfg.active_model_id,
            "messages": [{"role": "user", "content": prompt or "Say hello in one short sentence."}],
            "max_tokens": max(1, min(int(max_tokens or 128), 2048)),
            "stream": False,
        }
        t0 = time.time()
        try:
            timeout_s = max(30.0, cfg.timeout_ms / 1000.0)
            code, res = await asyncio.to_thread(_http_json, "POST", url, payload, timeout_s, headers)
        except Exception as exc:
            return {"ok": False, "error": f"Request to worker failed: {exc}"}

        dt = round(time.time() - t0, 2)
        if code != 200 or res.get("error"):
            err_msg = (
                res.get("error", {}).get("message")
                if isinstance(res.get("error"), dict)
                else res.get("error")
            ) or f"HTTP {code}"
            return {"ok": False, "error": str(err_msg), "duration_s": dt}

        choices = res.get("choices") or []
        reply = ""
        if choices and isinstance(choices[0], dict):
            reply = str((choices[0].get("message") or {}).get("content") or "")
        if not reply.strip():
            message = (choices[0].get('message') or {}) if choices else {}
            return {'ok': False, 'error': 'Model returned no answer text.' + (' Only reasoning was returned; the reply token limit may have been exhausted.' if message.get('reasoning_content') else ''), 'duration_s': dt}
        usage = res.get("usage") or {}
        comp_tokens = int(usage.get("completion_tokens") or 0)
        tok_s = usage.get("tok_per_s") or (round(comp_tokens / dt, 1) if dt > 0 and comp_tokens else 0.0)
        return {
            "ok": True,
            "reply": reply,
            "duration_s": dt,
            "tok_per_s": tok_s,
            "usage": usage,
            "model": res.get("model") or cfg.active_model_id,
        }


_SUPERVISOR: OpenVinoSupervisor | None = None


def get_supervisor() -> OpenVinoSupervisor:
    global _SUPERVISOR
    if _SUPERVISOR is None:
        _SUPERVISOR = OpenVinoSupervisor()
    return _SUPERVISOR
