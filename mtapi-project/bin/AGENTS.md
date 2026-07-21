# AGENTS.md — Bin Directory Agent Directives

> **Scope**: Binary & script directory `/home/m/snc/cod/ffTransmuteWebui/mtapi-project/bin`
> **Audience**: Autonomous AI Agents modifying CLI shell scripts or ffglitch JS scripts.

---

## 🎯 1. Mission & Operational Rules

Scripts in this directory interface directly with video processing binaries (`ffmpeg`, `ffgac`, `ffedit`).

Agents modifying binaries in `bin` MUST enforce:
- **Parity with Root Scripts**: Any fix or feature added to root `./transmute` or `./datamosh.sh` MUST be mirrored in `mtapi-project/bin/`.
- **Stdout Protocol Integrity**:
  - `transmute` MUST always output:
    `Output: <target_output_filepath>`
    `Command: <full_ffmpeg_command>`
    This output format is parsed by Python (`app/shell.py:parse_line`).
- **ffglitch Feature Exclusivity**:
  - In `custom_glitch.js`, requesting multiple features simultaneously in `args.features` (e.g. `['mv', 'q_dct']`) causes `ffedit` to fail. Request ONLY the required feature per execution mode.

---

## 🛠️ 2. Testing Scripts Directly

Agents can test script execution standalone via CLI:

```bash
# Test transmute dry run
./bin/transmute /path/to/clip.mp4 -s -d

# Test datamosh melt execution
./bin/datamosh.sh melt /path/to/clip.mp4 /path/to/output.mp4 30 5
```
