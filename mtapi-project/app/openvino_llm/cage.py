"""Abstracted process launch caging for the OpenVINO GenAI worker.

Supports:
1. `systemd_scope` — transient `systemd-run --user --scope` with MemoryMax,
   MemoryHigh, MemorySwapMax, OOMScoreAdjust (no `.service` unit file).
2. `cgroup_prlimit` — Void Linux / `runit` / no-systemd fallback using `prlimit`,
   direct `/proc/<pid>/oom_score_adj`, and user-delegated cgroup v2 files.
3. `none` — uncaged fallback for debugging.

Spec: docs/openvino-tab-spec.md §5
"""
from __future__ import annotations

import os
import re
import shutil
import signal
import time
from pathlib import Path
from typing import Any, Protocol

from .config import CageConfig

_MEM_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmgtKMGT]?[bB]?)\s*$")


def parse_mem_bytes(val: str) -> int | None:
    """Parse systemd-style memory string ('9G', '8192M', '0', 'infinity') into bytes."""
    s = str(val or "").strip()
    if not s or s.lower() in ("infinity", "max", "none", "-1"):
        return None
    if s == "0":
        return 0
    m = _MEM_RE.match(s)
    if not m:
        return None
    num = float(m.group(1))
    unit = m.group(2).upper().rstrip("B")
    mult = {
        "": 1,
        "K": 1024,
        "M": 1024**2,
        "G": 1024**3,
        "T": 1024**4,
    }.get(unit, 1)
    return int(num * mult)


def mem_available_mb() -> tuple[int, int]:
    """Return (MemAvailable_MB, MemTotal_MB) from /proc/meminfo."""
    avail_kb = 0
    total_kb = 0
    try:
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
                elif line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
    except OSError:
        pass
    return avail_kb // 1024, total_kb // 1024


def process_rss_mb(pid: int | None = None) -> int:
    """Return VmRSS in MB for `pid` (or current process if None)."""
    target = f"/proc/{pid}/status" if pid is not None else "/proc/self/status"
    try:
        with open(target, encoding="utf-8") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return 0


def detect_orphaned_ovms(exclude_pid: int | None = None) -> list[dict[str, Any]]:
    """Scan /proc for orphaned Intel AI Playground `ovms` processes holding iGPU GEM RAM.

    Pure Python /proc scan — never spawns a shell (AGENTS.md Invariant 2).
    """
    found: list[dict[str, Any]] = []
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return found
    own_pid = os.getpid()
    managed = {own_pid} | _descendant_pids(exclude_pid or own_pid)
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in managed:
            continue
        try:
            raw_cmd = (entry / "cmdline").read_bytes()
            if not raw_cmd:
                continue
            cmdline = " ".join(part.decode("utf-8", errors="replace") for part in raw_cmd.split(b"\x00") if part)
            lower = cmdline.lower()
            if ("ai-playground" in lower and "ovms" in lower) or "/openvino/ovms" in lower:
                # Ignore python processes that merely have ovms in PYTHONPATH
                exe_part = raw_cmd.split(b"\x00", 1)[0].decode("utf-8", errors="replace")
                if "ovms" in Path(exe_part).name.lower():
                    rss = process_rss_mb(pid)
                    found.append({"pid": pid, "rss_mb": rss, "cmdline": cmdline[:240]})
        except OSError:
            continue
    return found


def _listening_socket_targets(port: int) -> set[str]:
    """Return `socket:[<inode>]` strings for TCP sockets in LISTEN state on `port`."""
    targets: set[str] = set()
    port_hex = f"{int(port):04X}"
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table, encoding="utf-8") as f:
                for line in f.readlines()[1:]:
                    cols = line.split()
                    if len(cols) < 10:
                        continue
                    local_addr, state, inode = cols[1].upper(), cols[3].upper(), cols[9]
                    if state == "0A" and local_addr.endswith(f":{port_hex}") and inode != "0":
                        targets.add(f"socket:[{inode}]")
        except OSError:
            continue
    return targets


def _descendant_pids(root_pid: int | None) -> set[int]:
    """Return `root_pid` and all its descendant PIDs via `/proc/<pid>/status` PPid."""
    if not root_pid:
        return set()
    proc_root = Path("/proc")
    ppid_map: dict[int, list[int]] = {}
    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            with open(entry / "status", encoding="utf-8") as f:
                for line in f:
                    if line.startswith("PPid:"):
                        ppid = int(line.split()[1])
                        ppid_map.setdefault(ppid, []).append(pid)
                        break
        except OSError:
            continue
    result: set[int] = {root_pid}
    stack = [root_pid]
    while stack:
        cur = stack.pop()
        for child in ppid_map.get(cur, ()):
            if child not in result:
                result.add(child)
                stack.append(child)
    return result


def detect_stray_processes(port: int, exclude_pid: int | None = None) -> list[dict[str, Any]]:
    """Detect stray processes holding `port` or running unmanaged `vinoapi`/worker/`ovms` instances.

    Pure Python `/proc` inspection (no subprocess/shell).
    """
    found: list[dict[str, Any]] = []
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return found

    own_pid = os.getpid()
    uid = os.getuid()
    managed = {own_pid} | _descendant_pids(exclude_pid)
    sock_targets = _listening_socket_targets(port)
    port_str = str(int(port))

    for entry in proc_root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in managed:
            continue
        try:
            st = entry.stat()
            if st.st_uid != uid:
                continue
            raw_cmd = (entry / "cmdline").read_bytes()
            if not raw_cmd:
                continue
            parts = [p.decode("utf-8", errors="replace") for p in raw_cmd.split(b"\x00") if p]
            if not parts:
                continue
            cmdline = " ".join(parts)
            lower = cmdline.lower()
            exe_name = Path(parts[0]).name.lower()

            # Ignore non-daemon shell/curl probes
            if exe_name in ("bash", "sh", "zsh", "curl", "ss", "pgrep", "ps", "grep"):
                continue

            holds_port = False
            if sock_targets:
                fd_dir = entry / "fd"
                try:
                    for fd_entry in fd_dir.iterdir():
                        try:
                            link = os.readlink(fd_entry)
                            if link in sock_targets:
                                holds_port = True
                                break
                        except OSError:
                            continue
                except OSError:
                    pass

            if not holds_port and (
                f"--port {port_str}" in cmdline or f"--port={port_str}" in cmdline
            ):
                holds_port = True

            is_worker = "app.openvino_llm.worker" in cmdline
            is_legacy_vino = ("uvicorn" in lower and "server:app" in lower) or (
                "vinoapi" in lower and "uvicorn" in lower
            )
            is_ovms = "ovms" in exe_name and (
                "ai-playground" in lower or "/openvino/ovms" in lower
            )

            if holds_port or is_worker or is_legacy_vino or is_ovms:
                if is_worker:
                    kind = "worker"
                elif is_legacy_vino:
                    kind = "vinoapi"
                elif is_ovms:
                    kind = "ovms"
                else:
                    kind = "port_holder"
                found.append(
                    {
                        "pid": pid,
                        "rss_mb": process_rss_mb(pid),
                        "cmdline": cmdline[:240],
                        "holds_port": holds_port,
                        "port": int(port) if holds_port else None,
                        "kind": kind,
                    }
                )
        except OSError:
            continue

    found.sort(key=lambda x: (not x["holds_port"], -x["rss_mb"], x["pid"]))
    return found


def kill_stray_processes(
    port: int,
    exclude_pid: int | None = None,
    include_ovms: bool = False,
    target_pids: list[int] | None = None,
) -> dict[str, Any]:
    """Terminate stray `vinoapi` / worker / port-holding processes (SIGTERM -> SIGKILL).

    Returns `{"ok": bool, "killed": [...], "errors": [...]}`.
    """
    strays = detect_stray_processes(port, exclude_pid=exclude_pid)
    to_kill: list[dict[str, Any]] = []
    target_set = {int(p) for p in target_pids} if target_pids else None

    for item in strays:
        pid = int(item["pid"])
        if target_set is not None:
            if pid in target_set:
                to_kill.append(item)
            continue
        if item["holds_port"] or item["kind"] in ("worker", "vinoapi") or (
            include_ovms and item["kind"] == "ovms"
        ):
            to_kill.append(item)

    killed: list[dict[str, Any]] = []
    errors: list[str] = []

    for item in to_kill:
        pid = int(item["pid"])
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            killed.append({**item, "signal": "already_gone"})
            continue
        except PermissionError as exc:
            errors.append(f"PID {pid}: permission denied ({exc})")
            continue
        except OSError as exc:
            errors.append(f"PID {pid}: {exc}")
            continue

    deadline = time.time() + 2.5
    while time.time() < deadline:
        still_alive = [
            item for item in to_kill if Path(f"/proc/{item['pid']}").exists()
        ]
        if not still_alive:
            break
        time.sleep(0.1)

    for item in to_kill:
        pid = int(item["pid"])
        if any(k["pid"] == pid for k in killed):
            continue
        if Path(f"/proc/{pid}").exists():
            try:
                os.kill(pid, signal.SIGKILL)
                time.sleep(0.15)
                killed.append({**item, "signal": "SIGKILL"})
            except ProcessLookupError:
                killed.append({**item, "signal": "SIGTERM"})
            except OSError as exc:
                errors.append(f"PID {pid} SIGKILL failed: {exc}")
        else:
            killed.append({**item, "signal": "SIGTERM"})

    return {
        "ok": len(errors) == 0,
        "killed": killed,
        "errors": errors,
    }


def _write_oom_score_adj(pid: int, score: int) -> bool:
    """Best-effort write to /proc/<pid>/oom_score_adj."""
    clamped = max(-1000, min(1000, int(score)))
    try:
        Path(f"/proc/{pid}/oom_score_adj").write_text(f"{clamped}\n", encoding="utf-8")
        return True
    except OSError:
        return False


class CageLauncher(Protocol):
    id: str

    def available(self) -> bool: ...

    def build_argv(self, target_argv: list[str], cage: CageConfig) -> list[str]: ...

    def post_spawn(self, pid: int, cage: CageConfig) -> dict[str, Any]: ...


class SystemdScopeLauncher:
    """Cages the worker via transient `systemd-run --user --scope`.

    Does NOT create a persistent systemd unit file (`~/.config/systemd/user/*.service`).
    The child stays attached to the supervisor's stdout/stderr pipes and signal group.
    """

    id = "systemd_scope"

    def available(self) -> bool:
        if not shutil.which("systemd-run"):
            return False
        uid = os.getuid()
        return Path(f"/run/user/{uid}/systemd").exists() or Path("/run/systemd/system").exists()

    def build_argv(self, target_argv: list[str], cage: CageConfig) -> list[str]:
        exe = shutil.which("systemd-run") or "systemd-run"
        # Note: systemd-run --scope accepts systemd.resource-control(5) properties
        # (MemoryMax, MemoryHigh, MemorySwapMax); OOMScoreAdjust is applied directly
        # to /proc/<pid>/oom_score_adj in post_spawn() and worker startup.
        return [
            exe,
            "--user",
            "--scope",
            "-p", f"MemoryMax={cage.memory_max}",
            "-p", f"MemoryHigh={cage.memory_high}",
            "-p", f"MemorySwapMax={cage.memory_swap_max}",
            "--",
            *target_argv,
        ]

    def post_spawn(self, pid: int, cage: CageConfig) -> dict[str, Any]:
        oom_ok = _write_oom_score_adj(pid, cage.oom_score_adjust)
        return {
            "backend": self.id,
            "memory_max": cage.memory_max,
            "memory_high": cage.memory_high,
            "memory_swap_max": cage.memory_swap_max,
            "oom_score_adjust": cage.oom_score_adjust,
            "oom_score_applied": oom_ok,
        }


class CgroupPrlimitLauncher:
    """Void Linux / `runit` / no-systemd fallback launcher.

    Uses `prlimit` (if present) and writes `/proc/<pid>/oom_score_adj` plus
    user-delegated cgroup v2 limits when `/sys/fs/cgroup` is writable.
    """

    id = "cgroup_prlimit"

    def available(self) -> bool:
        return True

    def build_argv(self, target_argv: list[str], cage: CageConfig) -> list[str]:
        prlimit_bin = shutil.which("prlimit")
        max_bytes = parse_mem_bytes(cage.memory_max)
        # Note: OpenVINO GPU mmap virtual address space can exceed physical RSS,
        # so only apply RLIMIT_DATA or let cgroup v2 + in-process RSS watchdog enforce RSS.
        if prlimit_bin and max_bytes and max_bytes > 0:
            # Give virtual address space headroom (2x MemoryMax) while RSS watchdog + cgroup cap physical RAM
            as_bytes = max_bytes * 2
            return [
                prlimit_bin,
                f"--as={as_bytes}",
                "--",
                *target_argv,
            ]
        return list(target_argv)

    def post_spawn(self, pid: int, cage: CageConfig) -> dict[str, Any]:
        oom_ok = _write_oom_score_adj(pid, cage.oom_score_adjust)
        cg_path = self._try_apply_cgroup_v2(pid, cage)
        return {
            "backend": self.id,
            "memory_max": cage.memory_max,
            "memory_high": cage.memory_high,
            "memory_swap_max": cage.memory_swap_max,
            "oom_score_adjust": cage.oom_score_adjust,
            "oom_score_applied": oom_ok,
            "cgroup_v2_path": cg_path,
        }

    @staticmethod
    def _try_apply_cgroup_v2(pid: int, cage: CageConfig) -> str | None:
        """Best-effort direct cgroup v2 leaf creation on non-systemd (e.g. Void Linux) hosts."""
        try:
            proc_cg = Path(f"/proc/{pid}/cgroup").read_text(encoding="utf-8").strip()
            # Format: 0::/path/to/cgroup
            rel = ""
            for line in proc_cg.splitlines():
                parts = line.split(":", 2)
                if len(parts) == 3 and parts[0] == "0":
                    rel = parts[2].strip("/")
                    break
            if not rel:
                return None
            parent = Path("/sys/fs/cgroup") / rel
            if not parent.is_dir() or not os.access(parent, os.W_OK):
                return None
            leaf = parent / f"vinoapi-{pid}"
            leaf.mkdir(exist_ok=True)
            for fname, raw_val in (
                ("memory.max", cage.memory_max),
                ("memory.high", cage.memory_high),
                ("memory.swap.max", cage.memory_swap_max),
            ):
                bval = parse_mem_bytes(raw_val)
                if bval is not None:
                    try:
                        (leaf / fname).write_text(f"{bval}\n", encoding="utf-8")
                    except OSError:
                        pass
            (leaf / "cgroup.procs").write_text(f"{pid}\n", encoding="utf-8")
            return str(leaf)
        except OSError:
            return None


class UncagedLauncher:
    """Direct process spawn without cgroup wrapper (debug / explicit opt-out)."""

    id = "none"

    def available(self) -> bool:
        return True

    def build_argv(self, target_argv: list[str], cage: CageConfig) -> list[str]:
        return list(target_argv)

    def post_spawn(self, pid: int, cage: CageConfig) -> dict[str, Any]:
        oom_ok = _write_oom_score_adj(pid, cage.oom_score_adjust)
        return {
            "backend": self.id,
            "memory_max": cage.memory_max,
            "memory_high": cage.memory_high,
            "memory_swap_max": cage.memory_swap_max,
            "oom_score_adjust": cage.oom_score_adjust,
            "oom_score_applied": oom_ok,
        }


def resolve_launcher(backend: str = "auto") -> CageLauncher:
    """Resolve requested cage backend with automatic Void Linux / no-systemd fallback."""
    b = (backend or "auto").strip().lower()
    if b == "none":
        return UncagedLauncher()
    if b == "cgroup_prlimit":
        return CgroupPrlimitLauncher()
    systemd = SystemdScopeLauncher()
    if b in ("auto", "systemd_scope"):
        if systemd.available():
            return systemd
        return CgroupPrlimitLauncher()
    return CgroupPrlimitLauncher()
