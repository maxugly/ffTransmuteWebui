# AGENTS.md — Bin Directory Agent Directives

> **Scope**: Binary & script directory `/home/m/snc/cod/ffTransmuteWebui/mtapi-project/bin`
> **Audience**: Autonomous AI Agents modifying CLI shell scripts or ffglitch JS scripts.

---

## 1. Mission & Operational Rules

Scripts here interface with `ffmpeg` / ffglitch for **geometry CLI** and related tools.  
**Frame effects and Convert/Export codecs** live in Python (`app/video_pipeline`, `app/filters`, `app/convert_presets`) — do not reimplement neural dump/encode or ProRes/DNxHR tables in bash unless product asks for offline CLI parity.

Agents modifying binaries in `bin` MUST enforce:
- **Root scripts are authoritative**: `bin/transmute` must stay in sync with repo-root `transmute` when CLI flags change. Datamosh uses root `datamosh.sh` via `shell.py:DATAMOSH`.
- **Stdout Protocol Integrity**:
  - `transmute` MUST always output:
    `Output: <target_output_filepath>`
    `Command: <full_ffmpeg_command>`
    Parsed by Python (`app/shell.py:parse_line`).
- **ffglitch Feature Exclusivity**:
  - In glitch JS, request ONLY the required `args.features` feature per mode (e.g. do not combine incompatible `mv` + `q_dct`).

---

## 🛠️ 2. Testing Scripts Directly

Agents can test script execution standalone via CLI:

```bash
# Test transmute dry run
./bin/transmute /path/to/clip.mp4 -s -d

# Test datamosh melt execution (datamosh.sh lives at repo root, not bin/)
./datamosh.sh melt /path/to/clip.mp4 /path/to/output.mp4 30 5
```
