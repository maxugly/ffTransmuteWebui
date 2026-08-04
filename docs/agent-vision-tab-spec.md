# Agent Tab + Image → SD1.5 Prompt — Spec

> **Status:** **Implemented Phase A+API** (`000.000.4.59`) — Agent tab + CLI (agy/grok/stub) + **HTTP APIs** (DeepSeek, OpenRouter, xAI, OpenAI, Groq) via `~/.secrets`  
> **Audience:** Builders & reviewers  
> **Related:** `img2img` / `txt2img` (OpenVINO), `tilagup-mtapi-mode-spec.md`, tilagup agents at `/home/m/snc/cod/tilagup`, `STATUS.md`  
> **Not this (v1):** Full tilagup zones UI · autonomous multi-tool agent loop inside mtapi · training a custom VLM

---

## 0. Your questions (direct answers)

### 1a. Is there a **small local** multimodal model you could run?

**Yes — several “small enough for a laptop / Iris Xe” class options:**

| Model (ballpark) | Size | Notes for *image → caption / prompt* |
|------------------|------|--------------------------------------|
| **Moondream 2** | ~2B | Fast, tiny, decent captions; not SD-prompt-tuned |
| **Florence-2** (base/large) | small–med | Strong **caption / denser caption / OCR**; Microsoft; good local baseline |
| **Qwen2-VL-2B / 7B** | 2–7B | Strong open VL; 2B is the “small” pick |
| **LLaVA-OneVision / Phi-3.5-vision-ish** | varies | Caption OK; quality varies by quant |
| **InternVL2-1B/2B** | 1–2B | Competitive small VLMs |

On **this machine** you already run OpenVINO for SD turbo. Local VLMs usually want **transformers + GPU/CPU** or a separate llama.cpp/Ollama build — **not free** of setup. Fastest path to “something local that works”:

1. **Ollama** pull `moondream` or `llava` / `qwen2-vl` if available in your Ollama catalog  
2. Or **HuggingFace** Florence-2 / Moondream in a worker venv (similar to FastSD worker pattern)

**Honest default for “small + local”:** Moondream or Florence-2 for captions; then a **fixed template** turns caption → SD1.5-ish comma phrases (or a second tiny LLM rewrite).

### 1b. Would local do **anywhere near** as well as an API?

| Task | Small local (2–7B) | Strong API VLM (Grok/Claude/GPT-4o class) |
|------|--------------------|-------------------------------------------|
| “What’s in the photo?” | Often **good enough** | Better edge cases, text, weird art |
| **SD1.5-style prompt craft** (CLIP-aware order, materials, lighting, avoid prose) | **Mediocre** unless heavily prompted / templated | **Much better** — especially for img2img / tilagup base prompts |
| Tile-level unique detail (tilagup) | Weak consistency across tiles | Stronger if same model + good system prompt |
| Latency / cost | Free after download; slow on CPU | Credits; usually faster TTFT |

**Bottom line:** Local is fine for **labels and rough captions**. For **prompt that makes OpenVINO img2img look good**, CLI/API vision (what tilagup already uses) is still the quality tier you want. Hybrid is ideal: local for offline draft, CLI for “use this for img2img”.

### 2. Which models/APIs do vision → text well? DeepSeek? Free CLI?

| Provider / path | Vision? | Fit for SD prompts | Notes for you |
|-----------------|---------|--------------------|---------------|
| **Grok CLI** (`grok -p … --yolo`) | Yes (tools can open image paths) | **Excellent** | **Already on PATH**; tilagup uses it |
| **agy CLI** (`agy -p …`) | Yes (same path-in-prompt pattern) | **Excellent** | **Already on PATH**; tilagup uses it |
| **Codex CLI** | Depends on backend model | Variable | Available; less proven here for vision |
| **OpenCode** | Tool-using agent | Variable | Available; heavier |
| **OpenAI GPT-4o / 4.1** | Yes | Excellent | Paid API |
| **Anthropic Claude 3.5/4 vision** | Yes | Excellent | Paid API |
| **Google Gemini** | Yes | Excellent | Free tier sometimes |
| **xAI Grok API** | Yes | Excellent | If you have API key |
| **DeepSeek** | **Chat/code strong; vision product line is limited/unclear vs pure LLM** | **Do not plan v1 around DeepSeek vision** unless you confirm a **vision** endpoint in your account | Your **credits help text rewrite** (caption → SD prompt) more than “see the image” |

**Recommended v1 backends (in order):**

1. **`agy` / `grok` CLI** — zero new keys if already authenticated; matches tilagup  
2. Optional **Ollama local** for offline caption  
3. Optional **HTTP API** (OpenAI/Gemini/xAI) later behind the same interface  

**Not recommended as sole vision for v1:** DeepSeek text-only credits (use later as *rewrite* step: local caption → DeepSeek → SD prompt).

---

## 1. Product goal

### Phase A — **Agent tab** (chat + images)

A simple WebUI tab:

- Pick **backend** (`agy` | `grok` | later `ollama` | `http`)  
- **Chat** transcript (user / assistant)  
- Attach **one or more absolute image paths** (Browse / Image Pool send-to)  
- Send message; stream or block until reply  
- Actions: **Copy**, **Send prompt to Img2Img**, **Send to Txt2Img**

### Phase B — **Skill: image → SD1.5 prompt**

One-click or slash-skill:

```text
/image-prompt [/path/to.png]
```

or button **“Describe for SD1.5”** on Agent tab / Img2Img tab.

Returns:

- **Positive prompt** — ≤ ~50–75 CLIP-ish tokens, comma phrases, subject first  
- Optional **negative** preset  
- Optional **raw analysis** (hidden advanced)

This is the same skill tilagup needs for base/tile prompts — **shared module**, not a one-off.

---

## 2. Architecture

```text
WebUI Agent tab
    │
    ▼
POST /ops/agent_chat   or   POST /api/agent/chat
    │
    ▼
app/agents/          # new package (mtapi)
  backend.py         # Protocol: complete(messages, images) -> text
  cli_agy.py         # wrap agy -p
  cli_grok.py        # wrap grok -p --yolo
  ollama.py          # optional local
  skills/
    sd15_prompt.py   # system+user templates (from tilagup prompts_lib)
    chat.py          # freeform multimodal chat
    │
    ▼
subprocess CLI  or  Ollama HTTP  or  cloud API
```

**Reuse tilagup patterns** (do not import tilagup as a package dependency unless path-install):

| From tilagup | Port to mtapi |
|--------------|---------------|
| `agents/agy_agent.py`, `grok_agent.py` | `app/agents/cli_*.py` |
| `prompts_lib.BASE_SYSTEM` + image path wording | `app/agents/skills/sd15_prompt.py` |
| `clean_prompt_text` | shared cleaner |

**Invariant:** absolute image paths; `create_subprocess_exec` argv lists; progress/timeout via `job_control` for long calls.

---

## 3. Agent backends

### 3.1 CLI (v1 must-have)

```python
class AgentBackend(Protocol):
    id: str
    def available(self) -> bool: ...
    async def complete(
        self,
        *,
        system: str,
        user: str,
        image_paths: list[str],
        timeout_s: float = 300,
    ) -> AgentResult: ...
```

**Prompt construction for CLI vision (proven):**

```text
{system}

User message:
{user}

Images (open and inspect each path):
- /abs/a.png
- /abs/b.png
```

Grok: `grok -p "<full>" --yolo`  
Agy: `agy -p "<full>" --dangerously-skip-permissions`

Optional: `--model` if user set one in UI.

### 3.2 Ollama local (v1.1)

```text
POST http://localhost:11434/api/chat
model: moondream | llava | qwen2-vl
messages + images as base64
```

### 3.3 HTTP API (v1.2)

Pluggable: OpenAI-compatible `/v1/chat/completions` with image_url content parts. Config via env:

```text
MTAPI_AGENT_HTTP_BASE=
MTAPI_AGENT_HTTP_KEY=
MTAPI_AGENT_HTTP_MODEL=
```

DeepSeek: only if vision model id is confirmed; else use for **text-only rewrite** skill.

---

## 4. Skills

### 4.1 Freeform chat (`skill=chat`)

System: helpful creative assistant for video/image ops; may reference paths; do not invent file contents without reading.

### 4.2 SD1.5 prompt (`skill=sd15_prompt`) — **primary for img2img**

System (normative, short):

```text
You write SHORT Stable Diffusion 1.5 / CLIP prompts.
HARD LIMIT: ≤50 words, ≈75 tokens. Dense comma-separated phrases, not prose.
Order: subject and distinctive details FIRST, then materials, lighting, palette, style.
No markdown, no quotes, no preamble. Return ONLY the positive prompt line.
Optional second line starting with Negative: only if asked.
```

User:

```text
Image path (open and inspect): {path}

Write ONE SD1.5-style positive prompt for img2img that preserves composition
but enriches materials/lighting. Prompt only.
```

Post-process: `clean_prompt_text`, word count clamp, strip fences (tilagup `clean_prompt_text`).

### 4.3 Caption only (`skill=caption`) — local-friendly

“Describe the image in 2–3 sentences” — then optional DeepSeek/CLI rewrite to SD form.

---

## 5. API

### 5.1 `POST /ops/agent_chat` (or `/api/agent/chat`)

```json
{
  "backend": "grok",
  "skill": "chat",
  "message": "What materials dominate the right side?",
  "image_paths": ["/abs/photo.png"],
  "history": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "model": null,
  "timeout_s": 300,
  "dry_run": false
}
```

Response:

```json
{
  "ok": true,
  "operation": "agent_chat",
  "output_path": null,
  "stdout": "assistant reply text…",
  "items": [
    {"role": "assistant", "content": "…", "backend": "grok", "duration_ms": 4200}
  ]
}
```

For `skill=sd15_prompt`, also:

```json
{
  "prompt": "comma, separated, sd prompt",
  "negative_prompt": null
}
```

(extend `OperationResult` or put in `stdout` + structured fields if contract allows — prefer new optional fields or pack JSON in stdout with clear prefix `PROMPT:\n`).

**Builder preference:** add optional `OperationResult` fields only if clean; else return:

```text
PROMPT: ...
NEGATIVE: ...
---
(analysis)
```

### 5.2 `POST /ops/image_to_prompt` (thin alias)

Convenience for Img2Img button:

```json
{
  "image_path": "/abs/x.png",
  "backend": "agy",
  "variation": 0.35
}
```

Wraps `skill=sd15_prompt`.

---

## 6. WebUI — Agent tab

**Nav:** `Agent` (near Txt2Img / Img2Img).

```text
┌ Agent ─────────────────────────────────────────────┐
│ Backend: [grok ▼]  Model: [default        ]        │
│ Skill:   (•) Chat  ( ) SD1.5 prompt  ( ) Caption   │
│                                                    │
│ Images: [ + file ] [ from Image Pool ]             │
│   • /path/a.png  ✕                                 │
│                                                    │
│ ┌ transcript ───────────────────────────────────┐  │
│ │ user: …                                       │  │
│ │ agent: …                                      │  │
│ └───────────────────────────────────────────────┘  │
│ [ message ........................ ] [Send]        │
│ [Copy last] [→ Img2Img prompt] [→ Txt2Img]         │
└────────────────────────────────────────────────────┘
```

**State:** `state.agent = { backend, skill, images[], history[] }` — session-only v1; persistence later.

**Send to Img2Img:** fill `i2iPrompt` + if one image set `i2iInput`, switch tab.

---

## 7. Img2Img integration (first consumer)

On **Img2Img** tab:

- Button **“Prompt from image”** (needs input path)  
- Calls `/ops/image_to_prompt` with current input  
- Sets Prompt field  
- User adjusts strength and Runs  

This is the **first closed loop**: look → prompt → OpenVINO img2img.

---

## 8. Implementation phases

### Phase A — Agent tab + CLI backends (ship this first)

1. `app/agents/` package: protocol, agy, grok, cleaners  
2. `POST /ops/agent_chat` + `POST /ops/image_to_prompt`  
3. WebUI Agent tab (chat + attach paths + skill toggle)  
4. Img2Img **Prompt from image** button  
5. Progress: phase `agent`, message streaming optional (v1 block until done)  
6. VERSION + STATUS  

### Phase B — Local Ollama

7. Backend `ollama` + model dropdown  
8. Caption skill default for local  

### Phase C — Tilagup readiness

9. Shared `sd15_prompt` + tile prompt skill (unique-first)  
10. Batch: list of crops → list of prompts (feeds tilagup mode)  

### Phase D — Cloud HTTP + DeepSeek rewrite

11. OpenAI-compatible vision HTTP  
12. Optional: local caption → DeepSeek text rewrite → SD prompt  

---

## 9. Files to touch

| File | Role |
|------|------|
| `app/agents/__init__.py` | exports |
| `app/agents/base.py` | Protocol, clean_prompt_text, run_argv async |
| `app/agents/cli_agy.py` | agy backend |
| `app/agents/cli_grok.py` | grok backend |
| `app/agents/skills/sd15_prompt.py` | templates |
| `app/operations/agent_ops.py` | HTTP ops register |
| `app/static/js/tabs/agent.js` | UI |
| `index.html` / `app.js` / `job-control.js` | nav + run |
| Img2Img tab | “Prompt from image” button |

---

## 10. Pitfalls

| Pitfall | Mitigation |
|---------|------------|
| CLI not logged in / no vision | `available()` check; clear error |
| Agent returns essay | hard rewrite pass (tilagup `_ensure_short_prompt`) |
| Relative paths | resolve absolute before CLI |
| Blocking event loop | `asyncio.create_subprocess_exec` + timeout |
| Secrets in UI | never log full API keys |
| DeepSeek assumed multimodal | verify before wiring; use as rewrite only |
| Codex/OpenCode cost/latency | keep optional, not default |

---

## 11. Verification

1. Agent tab: backend grok, attach `/tmp/teste.png`, skill SD1.5 prompt → short comma prompt.  
2. **→ Img2Img** fills prompt; Run dry_run OK.  
3. Free chat with image: sensible description.  
4. Missing CLI: `ok: false` with install hint.  
5. Console clean; cancel kills subprocess if possible.

---

## 12. Recommendation (product call)

| Priority | Choice |
|----------|--------|
| **Ship first** | Agent tab + **agy/grok CLI** + SD1.5 skill + Img2Img button |
| **Local later** | Ollama Moondream/Florence for offline |
| **DeepSeek** | Hold for **text rewrite** after you confirm vision; don’t block v1 |
| **Quality bar** | CLI vision ≈ “API-class” for your workflow already; small local ≈ “draft only” |

---

## 13. One-line summary

**Add an Agent tab that talks to grok/agy (then optional local/API), with a first-class “image → short SD1.5 prompt” skill feeding Img2Img — the same foundation tilagup will need for base/tile prompts.**
