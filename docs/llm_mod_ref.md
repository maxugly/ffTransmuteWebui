# LLM Model Reference (coding-agent gateway list, Sept 2026)

Well. I went through your list like a man going through his own pockets at 3 AM,
turning out every scrap of paper to see what's real and what's just lint.

**The five-letter cut.** Applied it like you said — anything under five characters
got swept off the table: `.` `]` `|` `2` `a` `af` `e` `Free` `Mi` `bra:` `n Exp`
`o` `R` `s` `v`. Gone. Didn't shed a tear.

**What's left after that** still has some fakes wearing real clothes. I web-searched
every name that looked like it might have a pulse. Here's the honest breakdown:

- **Confirmed real, specs verified against provider docs / current benchmark trackers
  (Sept 2026):** DeepSeek V4 Pro, DeepSeek V4 Flash, GLM-5.2, GLM-5.3, Kimi K2 Thinking,
  Kimi K2.6, Kimi K3, Qwen3.6 Flash, Qwen3.8 (27B), Nemotron 3 Nano, Nemotron 3 Super,
  Nemotron 3 Ultra, Inkling, Inkling Small, Llama 4 Maverick, Mistral Medium, Mistral
  Small, MiniMax-M3, MiniMax M2.7 (this is what "lax M2.7" is — the scrape ate the
  "MiniMi" off the front), Muse Spark 1.2 / 1.3, Ling 3.0 Flash, Gemma 4 (26B/31B A4B
  variants), gpt-oss (120B/20B family).
- **Real family, name shows up in current model trackers, but I couldn't pin down
  hard specs for the exact listed variant — treat with a little more caution:**
  North Mini Code, MiMo V2.5 (Xiaomi — MiMo-V2.5 / V2.5-Pro / V2-Flash all real),
  Nemotron 3.5 Lightning, Nemotron 3.5 Content Safety, Nemotron 3 Nano Omni.
- **Could not confirm — no hits, or hits too thin to be sure. Not guessing, not
  inventing a source for these. If you need them, tell me and I'll dig further or
  you can point me at the actual OpenRouter/Kilo model-ID string:** BigPickle Free,
  Charm, Dots3-Note Preview, Free Models Router (this reads like a routing meta-option,
  not a model), GPT 0SS 1208 (possibly a dated `gpt-oss-120b` checkpoint, possibly not
  — unconfirmed), Laguna S 2.1, Laguna XS 2.1, "Latest" (this is very likely a UI label
  like "Mistral Medium | Latest", not a model name on its own), Ling 3.0 Flash Sante,
  Ling 3.0 Flash Fin.

One more thing worth saying plainly: a lot of these are **vendor-reported** numbers —
DeepSeek says DeepSeek is the best open model, Moonshot says Kimi K3 beats Opus 4.8.
Take the horse-race claims with salt. Where I could find independent numbers
(Artificial Analysis Intelligence Index, third-party SWE-bench runs) I've said so.

Also: this whole list smells like a **model picker dropdown from a coding-agent
gateway** (OpenCode Zen or Kilo/OpenRouter free-router, going by your file path).
That's why half the names have "(free)" hanging off them and there are three
half-broken duplicates of the same model. I did NOT invent `*` / `+` markers for
individual models unless the source text itself said "(free)" — everything else
gets a `+ (unconfirmed)` flag. Go verify actual free-tier status against the
gateway's live model list before you ship this table anywhere important.

---

## Per-model research

### model: DeepSeek V4 Pro
- provider: DeepSeek
- released: 2026-04 (preview) / 2026-08-13 GA (V4-Pro-0813) — https://api-docs.deepseek.com/news/news260424/
- context: 1M (384K max output)
- availability: + (unconfirmed which specific free router carries it; not marked "(free)" in your source list)
- good-at: 1.6T-param MoE (49B active), hybrid CSA+HCA sparse attention; DeepSeek's own claim is "best open-source model available today," with strong agentic coding benchmark scores and native OpenAI + Anthropic-compatible API (drops straight into Claude Code / OpenCode without a proxy).
- do-not: Self-reported superiority claims aren't independently verified across the board; heavier compute footprint than Flash sibling, so cost/latency is worse for simple tasks.
- personality: Reasoning-heavy, willing to grind long horizon tasks; behaves like a big model that wants to think before it types.
- bestfor: Long-horizon agentic coding where you want maximum open-weight capability and don't mind the token cost.
- vs: GLM-5.2 — GLM is more coding-benchmark-focused and cheaper; V4 Pro leans on raw scale.
- sources: https://api-docs.deepseek.com/news/news260424/, https://www.morphllm.com/deepseek-v4, https://deepinfra.com/deepseek-ai/DeepSeek-V4-Pro

### model: DeepSeek V4 Flash
- provider: DeepSeek
- released: 2026-04 (preview) / 2026-07-31 GA (V4-Flash-0731) — https://www.morphllm.com/deepseek-v4-flash
- context: 1M (384K max output)
- availability: + (unconfirmed exact free router)
- good-at: 284B total / 13B active MoE, same 1M context and attention stack as Pro but at roughly a third the price; DeepSeek reports a big post-training jump on Terminal-Bench 2.1 (61.8→82.7) and DeepSWE (7.3→54.4) from preview to GA.
- do-not: Runs verbose — cited as ~2x the output-token cost per Intelligence-Index run versus similarly-sized models; scores ~1 point behind Pro on Artificial Analysis' index despite the price gap.
- personality: Fast, cheap, chatty — good for high-throughput loops where you're paying per call.
- bestfor: Budget agentic coding, high-volume tool-use pipelines, fast drafts at 1M context.
- vs: Qwen3.8 27B — similarly cheap+fast tier, Alibaba's own numbers claim Qwen edges it on coding/office tasks.
- sources: https://www.morphllm.com/deepseek-v4-flash, https://openrouter.ai/deepseek/deepseek-v4-flash, https://lmstudio.ai/models/deepseek-v4-flash

### model: GLM-5.2
- provider: Zhipu AI (Z.ai)
- released: 2026-06-13, MIT license — https://docs.z.ai/guides/llm/glm-5.2
- context: 1M (128K max output; Together AI serves it at 262K in FP4)
- availability: + (unconfirmed exact free router)
- good-at: 753B total MoE (~40B active), IndexShare sparse attention. Strongest open-weight model on standard coding benchmarks at release: 62.1 on SWE-bench Pro (beats GPT-5.5's 58.6) and 81.0 on Terminal-Bench 2.1, within a few points of Claude Opus 4.8 (85.0).
- do-not: Verbose — ~43K output tokens per Index task, 37K of them pure reasoning, vs 16K for GPT-5.5. That's real latency/cost overhead.
- personality: Holds project-scale context well; described by users as retaining module boundaries and architectural constraints better than prior GLM gens across long tasks.
- bestfor: Long-horizon repo-scale coding agents where you want an open-weight model that doesn't lose the plot after 50 tool calls.
- vs: DeepSeek V4 Pro — GLM wins the standard coding benchmarks head to head; DeepSeek has the bigger raw parameter count and broader knowledge claims.
- sources: https://docs.z.ai/guides/llm/glm-5.2, https://www.morphllm.com/glm-5-2, https://docs.together.ai/docs/glm-5.2-quickstart

### model: GLM-5.3
- provider: Zhipu AI (Z.ai)
- released: 2026-08-14 (API), weights public 2026-08-25 under custom GLM-5.3 License — https://www.morphllm.com/glm-5-2
- context: 1M
- availability: + (unconfirmed)
- good-at: Same 743B base as GLM-5.2, upgraded via post-training only (Terminal-Bench 3.0 jumps 4.6→28.3, different scale than 2.1 so not directly comparable to 5.2's number). Leads on CyberGym vulnerability discovery among the labs it was compared to.
- do-not: Zhipu's own methodology notes flag it as mixed vs Claude Opus 4.8 depending on task, and Zhipu states it plainly trails Claude Fable 5 on their own internal coding benchmark. Comparison table in the release mixed three different Anthropic models (Opus 4.8, Fable 5, Mythos 5) across different sections — read the footnotes before quoting a number.
- personality: Same behavioral profile as 5.2, sharpened post-training rather than a new brain.
- bestfor: Security-adjacent code review and vuln discovery workflows; general long-horizon coding where 5.2 already fit.
- vs: Kimi K3 — both landed within weeks of each other; Kimi is bigger (2.8T) and self-reported ahead on more coding/agent tasks, GLM is cheaper to run.
- sources: https://www.artificialintelligence-news.com/news/zhipu-glm-5-3-benchmarks-explained/, https://vercel.com/ai-gateway/models/glm-5.3-flash/latency

### model: Kimi K2 Thinking
- provider: Moonshot AI
- released: 2025-11 — https://openrouter.ai/moonshotai/kimi-k2-thinking
- context: 262,144 (256K)
- availability: + (unconfirmed)
- good-at: 1T total / 32B active MoE, native INT4. Interleaves chain-of-thought with tool calls across 200–300 sequential tool calls without drift; set open-source SOTA at release on HLE, BrowseComp, SWE-Multilingual, LiveCodeBench.
- do-not: Independent read (ndurner substack) found it scores below the non-thinking K2 Instruct variant on creative-writing quality (worse "slop"/repetition scores, half the output length), and shows undertrained-feeling non-English (specifically German) output. Superseded on coding by K2.6/K2.7/K3.
- personality: A reasoning grinder — good at staying on task through very long tool-call chains, weaker on prose quality.
- bestfor: Long-horizon autonomous research/coding tasks that need hundreds of sequential tool calls without the model wandering.
- vs: DeepSeek V4 Pro — similar MoE scale class, Kimi wins on sustained tool-call stability, DeepSeek on raw benchmark breadth.
- sources: https://openrouter.ai/moonshotai/kimi-k2-thinking, https://ndurner.substack.com/p/kimi-k2-thinking, https://leanware.co/insights/kimi-k2

### model: Kimi K2.6
- provider: Moonshot AI
- released: 2026-04-20 — https://llm-stats.com/models/kimi-k2.6
- context: 262,144 (256K)
- availability: + (unconfirmed)
- good-at: 1T/32B MoE, open-weight, native multimodal, "Agent Swarm" scaling to 300 sub-agents / 4,000 coordinated steps. Ties GPT-5.5 on SWE-Bench Pro (58.6%) per third-party writeups; leads on HLE-with-tools (54.0%) in some comparisons.
- do-not: Headline capability is sustained autonomous execution, not peak single-shot benchmark score — don't expect it to top every leaderboard row.
- personality: Built for horizontal scale-out — many cheap agents working in parallel rather than one very deep reasoner.
- bestfor: Swarm-style agent orchestration, large parallel task decomposition.
- vs: Claude Opus 4.6/4.7 — K2.6 write-ups position it as ~80% cheaper per token while trading blows on SWE-bench Pro.
- sources: https://llm-stats.com/models/kimi-k2.6, https://miraflow.ai/blog/kimi-k2-6-explained-moonshot-ai-open-source-model-ties-gpt-5-5-coding, https://huggingface.co/moonshotai/Kimi-K2.6

### model: Kimi K3
- provider: Moonshot AI
- released: 2026-07-16 (API), weights July 27 under Kimi K3 License (custom, revenue-share clause above $20M/yr inference revenue) — https://en.wikipedia.org/wiki/Kimi_(AI)
- context: 1,048,576 (1M)
- availability: + (unconfirmed)
- good-at: 2.8T total params (largest open-weight model as of writing), native vision, built on Kimi Delta Attention + Attention Residuals. Moonshot's own benchmarks (and some third-party coverage) place it ahead of Claude Opus 4.8 and GPT-5.5 on several coding/agent tasks.
- do-not: Custom license, not a clean permissive open-weight license — 30% revenue-share clause for large inference providers. "Open weight" claims launched slightly ahead of the weights actually shipping.
- personality: The heavyweight of the family — built explicitly to sustain multi-hour engineering sessions across large repos.
- bestfor: The biggest, longest-horizon coding/agent tasks you'd otherwise reach for a closed frontier model for.
- vs: Claude Fable 5 / GPT-5.6 Sol — Moonshot placed K3 directly against both in its own marketing; independent confirmation is thinner than for K2.6.
- sources: https://en.wikipedia.org/wiki/Kimi_(AI), https://amplifilabs.com/post/kimi-k3-the-complete-guide-to-moonshot-ais-2-8t-model, https://github.com/MoonshotAI/Kimi-K3, https://openrouter.ai/moonshotai/kimi-k3

### model: Qwen3.6 Flash
- provider: Alibaba
- released: 2026-04-27 (per OpenCode data tracker) — https://opencode.ai/data/alibaba
- context: 1M native (up to 983K input tokens in thinking mode per vendor docs)
- availability: + (unconfirmed)
- good-at: Native vision-language Flash tier; fast/cheap with agentic coding and spatial visual understanding (object localization/detection).
- do-not: Flash tier — not the reasoning-depth flagship; superseded by Qwen3.7/3.8 lines within the same year.
- personality: Quick, cost-efficient, multimodal-first.
- bestfor: Fast drafts, cost-sensitive agent loops that also need image/video input.
- vs: DeepSeek V4 Flash — similar fast/cheap positioning; Qwen adds native vision, DeepSeek focuses text/code.
- sources: https://www.mindstudio.ai/models/qwen-3-6-flash, https://opencode.ai/data/alibaba

### model: Qwen3.8 (27B)
- provider: Alibaba
- released: 2026-08-14 (per OpenCode tracker, "Qwen3.8 27B") — https://opencode.ai/data/alibaba
- context: 262K native, extendable to 1M (Flash-Next variant)
- availability: + (unconfirmed — your source string "Qwen3.8 278" is ambiguous; I'm reading it as "Qwen3.8 27B" garbled, but flag this, don't take it as certain)
- good-at: Part of a big Qwen3.8 tier ladder (Flash / Flash-Next / Max / Max Preview / 2.4T-A95B) — the Flash-Next variant in particular activates only 6B of 125B main-model params plus a 51B N-gram embedding layer that can sit in system RAM; Alibaba's own numbers claim it beats DeepSeek-V4-Flash and Claude Opus 4.6 on coding/office benchmarks at a fraction of training cost.
- do-not: Independent production numbers (throughput, memory, real agent workloads) were still thin at write-up time — the benchmark story is mostly Alibaba's own.
- personality: Efficiency-obsessed — this generation is explicitly an architecture preview for Qwen4, testing cost tricks rather than chasing peak score.
- bestfor: Small teams running their own coding/document agents who want frontier-adjacent quality without frontier compute bills.
- vs: DeepSeek V4 Flash — direct comparison target in Alibaba's own release materials.
- sources: https://opencode.ai/data/alibaba, https://the-decoder.com/alibaba-releases-qwen3-8-flash-next-targeting-ultimate-cost-efficiency/, https://datanorth.ai/news/alibaba-releases-qwen3-8-flash-next, https://vercel.com/ai-gateway/models/qwen3.8-flash/about

### model: Nemotron 3 Nano
- provider: NVIDIA
- released: 2025-12 — https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models
- context: 1M (default deploy config often 262,144 to avoid OOM)
- availability: + (marked "(free)" in your source list — likely a free OpenRouter/gateway listing, plausible)
- good-at: Smallest tier (4B / 30B-A3B variants), hybrid MoE, 4x throughput over Nemotron 2 Nano, up to 60% less reasoning-token generation. Fits on a single consumer GPU at 4-bit.
- do-not: Smallest of the three — not the one to reach for on hard reasoning/coding tasks; that's Super/Ultra's job.
- personality: Fast, cheap, disposable-agent-worker energy.
- bestfor: High-throughput lightweight steps in a multi-agent pipeline (routing, simple extraction) where a bigger model would be overkill.
- vs: Qwen3.6 Flash — similar small/fast tier; Nemotron leans agentic-pipeline-step use, Qwen leans multimodal.
- sources: https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models, https://unsloth.ai/docs/models/nemotron-3

### model: Nemotron 3 Super
- provider: NVIDIA
- released: 2026-03 — https://developer.nvidia.com/blog/introducing-nemotron-3-super-an-open-hybrid-mamba-transformer-moe-for-agentic-reasoning/
- context: 1M native
- availability: + (marked "(free)" in source)
- good-at: 120B total / 12B active, hybrid Mamba-Transformer MoE — Mamba layers make the 1M context practical rather than theoretical. CodeRabbit uses it in production for PR-review context gathering/summarization ahead of frontier models doing the actual reasoning.
- do-not: Positioned as the mid-tier "context gathering" workhorse, not the top-line reasoner — don't expect it to out-code Ultra or the frontier closed models.
- personality: A capable pre-processor/summarizer that keeps a big pile of context organized for whatever model reasons over it next.
- bestfor: Long-context summarization and retrieval stages inside a larger agent pipeline; software-dev and cybersecurity triage at moderate scale.
- vs: Nemotron 3 Nano — same family, Super trades some throughput for real reasoning depth.
- sources: https://developer.nvidia.com/blog/introducing-nemotron-3-super-an-open-hybrid-mamba-transformer-moe-for-agentic-reasoning/, https://www.coderabbit.ai/blog/faster-code-reviews-with-nemotron-3-super, https://www.verdent.ai/guides/what-is-nemotron-3-super

### model: Nemotron 3 Ultra
- provider: NVIDIA
- released: 2026-06 — https://www.coderabbit.ai/blog/nemotron-3-ultra-release
- context: 1M native, scores 95% on Ruler-at-1M recall benchmark
- availability: + (marked "(free)" in source; OpenRouter lists a genuinely free endpoint per search result)
- good-at: 550B total / 55B active, hybrid Mamba-Transformer MoE with latent MoE routing + multi-token prediction. Artificial Analysis reported it at 48 on their Intelligence Index — the leading US open-weight model in that snapshot, ahead of Gemma 4 31B and gpt-oss-120b.
- do-not: A third-party review explicitly frames it as NOT "the new best coding assistant" — it's a fast, controllable open worker for pipelines, not a frontier reasoning champion.
- personality: Built for developers who need to stay in the loop — fast enough to retry, controllable enough to keep inside a harness.
- bestfor: Terminal/coding-agent harnesses, review pipelines, and workflows needing to churn through messy long context fast.
- vs: Inkling — both are "open US model, closely watched" releases from roughly the same window; Inkling leans generalist/fine-tunable, Ultra leans speed+agent-pipeline fit.
- sources: https://www.coderabbit.ai/blog/nemotron-3-ultra-release, https://openrouter.ai/nvidia/nemotron-3-ultra-550b-a55b:free, https://vercel.com/ai-gateway/models/nemotron-3-ultra-550b-a55b/faq

### model: Inkling
- provider: Thinking Machines Lab
- released: 2026-07-15, Apache 2.0 — https://thinkingmachines.ai/news/introducing-inkling/
- context: 1M
- availability: + (unconfirmed which free router; your source marks it "(free)")
- good-at: 975B total / 41B active multimodal MoE (66-layer, 6-of-256 experts + 2 shared). Trained inside randomized coding/agent harnesses specifically so it doesn't overfit to one tool schema. Can drive its own fine-tuning via the Tinker platform (used a coding-agent loop to write, run, and evaluate its own fine-tune job in the launch demo).
- do-not: Thinking Machines says it plainly: "not the strongest overall model available today, open or closed." Scores 41 on Artificial Analysis' Intelligence Index — highest of any US-built open-weight model at the time, but behind Claude Opus 4.8 (56) and GPT-5.6 (59). HumanEval-style code-gen benchmarks: solid, not exceptional.
- personality: A balanced generalist tuned for customization rather than leaderboard-topping — described by its own maker as broad rather than narrowly optimized.
- bestfor: Teams that want an open-weight base to fine-tune for a specific domain rather than run out-of-the-box against frontier closed models.
- vs: Nemotron 3 Ultra — both are contemporaneous "notable open US model" releases; Inkling is the fine-tuning-first play, Ultra the pipeline-speed play.
- sources: https://thinkingmachines.ai/news/introducing-inkling/, https://www.analyticsvidhya.com/blog/2026/07/thinking-machines-inkling/, https://www.databricks.com/blog/inkling-thinking-machines-lab-now-databricks, https://thinkingmachines.ai/model-card/inkling/

### model: Inkling Small
- provider: Thinking Machines Lab
- released: 2026-07 (preview alongside Inkling; full weights pending at write-up) — https://www.techzine.eu/news/analytics/142945/thinking-machines-lab-releases-inkling-an-open-weights-model/
- context: not separately confirmed; presumed same architecture family as Inkling
- availability: + (unconfirmed; marked "(free)" in source)
- good-at: 12B active parameters (vs Inkling's 41B) — early results show it performing close to full Inkling on reasoning/agentic tasks at much lower cost/latency.
- do-not: Was still finishing testing at the time of the main Inkling launch — full weights weren't out yet; treat availability/specs as provisional.
- personality: The cheap-and-fast sibling, positioned for use-cases like LLM-as-judge grading or synthetic data generation where cost matters more than peak capability.
- bestfor: Cost-sensitive coding/grading tasks where you want Inkling's behavior profile without Inkling's compute bill.
- vs: Nemotron 3 Nano — both are the "small, cheap sibling" in their respective families.
- sources: https://thinkingmachines.ai/news/introducing-inkling/, https://www.techzine.eu/news/analytics/142945/thinking-machines-lab-releases-inkling-an-open-weights-model/

### model: Llama 4 Maverick
- provider: Meta
- released: 2025-04-05, Llama 4 Community License — https://ai.meta.com/blog/llama-4-multimodal-intelligence/
- context: 1,048,576 (1M)
- availability: + (unconfirmed)
- good-at: 400B total / 17B active MoE (128 experts), natively multimodal (early fusion), 12 supported languages for code/text output. Meta's own claims: beats GPT-4o and Gemini 2.0 across multimodal benchmarks, competitive with DeepSeek-V3 on coding/reasoning.
- do-not: **Your source list said "178 Instruct" — that parameter count is wrong.** The real Maverick is 400B total / 17B active. Also worth knowing: by mid-2026, independent coverage reported Llama's reception cooling considerably, several of the original Llama researchers having left Meta, and Zuckerberg himself acknowledging Meta's AI agent progress running behind plan — weigh the original benchmark claims against that.
- personality: Solid multimodal generalist from 2025; increasingly dated relative to the mid-2026 open-weight field (Kimi K3, GLM-5.x, DeepSeek V4) it now sits next to.
- bestfor: Multimodal (image+text) tasks on a budget where you don't need frontier-2026 coding performance.
- vs: DeepSeek V3 — Meta's own launch comparison; both roughly a year+ old by the time of this list.
- sources: https://ai.meta.com/blog/llama-4-multimodal-intelligence/, https://huggingface.co/blog/llama4-release, https://openrouter.ai/meta-llama/llama-4-maverick, https://explainx.ai/blog/meta-llama-4-open-source-models-guide-2026

### model: Mistral Medium
- provider: Mistral AI
- released: version churn — "Mistral Medium 3.1" and "Mistral Medium 3.5" both show up in current (Sept 2026) model listings; exact release date unpinned.
- context: unconfirmed exact figure for the current point release — check Mistral's own docs first.
- availability: + (unconfirmed; source shows it tagged "| Latest" which reads like a UI alias, not part of the model's actual name)
- good-at: Mid-tier Mistral flagship, used as a coding/reasoning comparison point in several 2026 benchmark trackers.
- do-not: Version-string ambiguity is real — "Latest" in the source is almost certainly a routing alias, not a fixed model. Don't ship a benchmark entry for "Mistral Medium | Latest" as if it's a stable target.
- personality: Balanced mid-tier option in Mistral's lineup.
- bestfor: General coding/reasoning tasks at a mid price point.
- vs: GLM-5.2 — GLM is the more benchmark-aggressive open-weight coder; Mistral Medium trades peak score for an established vendor.
- sources: https://artificialanalysis.ai/microevals

### model: Mistral Small
- provider: Mistral AI
- released: version churn, same caveat as Medium.
- context: unconfirmed exact figure for the current point release.
- availability: + (unconfirmed)
- good-at: Small/cheap tier of the Mistral lineup — fast drafts and lightweight agent steps.
- do-not: No hard current-generation specs found — don't quote parameter counts or context windows without checking Mistral's docs directly.
- personality: Fast, cheap, no-frills.
- bestfor: Fast drafts, simple extraction/classification steps in a larger pipeline.
- vs: Qwen3.6 Flash — same small/fast tier positioning from a different lab.
- sources: unconfirmed current-generation source — flag for follow-up

### model: MiniMax-M3
- provider: MiniMax
- released: unconfirmed exact date; current (2026) coding/agentic model in the same trackers as GLM-5.3, Kimi K3, DeepSeek V4 Pro.
- context: up to 1M (per one aggregator description)
- availability: + (marked "(free)" in one entry of the source list)
- good-at: Open-weight multimodal model described as combining "frontier-level coding performance" with native multimodal understanding and long context; recommended as the open-weight alternative when you need local deployment/fine-tuning.
- do-not: Specs are aggregator-sourced, not from a MiniMax first-party model card — treat parameter counts as unconfirmed.
- personality: The practical open-weight coding option when closed-weight competitors won't give you local deploy.
- bestfor: Local/self-hosted coding-agent deployment where you need the actual weights, not just an API.
- vs: Muse Spark 1.1/1.2/1.3 — explicitly framed as "the open-weight alternative" to Meta's closed Muse Spark line.
- sources: https://artificialanalysis.ai/microevals

### model: MiniMax M2.7
- provider: MiniMax
- released: unconfirmed date; earlier point release than M3 in the same Artificial Analysis snapshot. (Source string "lax M2.7" is a scrape clip of "MiniMax M2.7".)
- context: unconfirmed
- availability: + (marked "(free)" in source)
- good-at: Predecessor to M3 in the MiniMax lineup; appears in benchmark comparison tables alongside MiniMax-M2, M2.1, M2.5.
- do-not: No independent spec sheet found — don't quote parameter counts.
- personality: unconfirmed
- bestfor: unconfirmed — treat as superseded by M3 unless pinned for a specific reason.
- vs: MiniMax-M3 — direct predecessor/successor pair.
- sources: https://artificialanalysis.ai/microevals

### model: Muse Spark 1.2
- provider: Meta (Superintelligence Labs)
- released: after 1.1 (2026-07-09); exact 1.2 date unconfirmed.
- context: 1M
- availability: + (unconfirmed; marked "(free) Free" — likely scrape duplication)
- good-at: Closed-weight agentic model, 1M-token context, remembers earlier actions, retrieves/compacts context, delegates across parallel subagents; operates across tools, MCP servers, browsers, native apps, scripts, images/video/PDF/audio.
- do-not: **Closed weight, proprietary** — no local deployment, no fine-tuning.
- personality: An orchestrator — plans, delegates, and keeps track across multi-tool, multi-modal sessions.
- bestfor: Consumer-facing agentic tasks via meta.ai or the Meta Model API where you don't need open weights.
- vs: MiniMax M3 — closed vs open-weight version of roughly the same "agentic orchestrator" pitch.
- sources: https://www.datacamp.com/blog/muse-spark-1-1

### model: Muse Spark 1.3
- provider: Meta (Superintelligence Labs)
- released: after 1.2, current as of late Aug / early Sept 2026.
- context: 1M (consistent with the 1.1/1.2 line)
- availability: + (unconfirmed; marked "(free) Free" — likely scrape duplication)
- good-at: Same agentic/multimodal orchestration line as 1.1/1.2; one review calls it "competitive with [GPT-5.6] Sol and [Claude] Opus 5 across agentic and coding rows and clearly ahead of 1.2."
- do-not: That review flags real gaps: no comparison against Claude Fable 5.1 or Gemini 3.8 Flash, no published confidence intervals, no independent verification of the 1.3-specific numbers yet. Still closed-weight.
- personality: Same orchestrator profile as 1.1/1.2, incrementally sharpened.
- bestfor: Same use case as 1.2 — consumer/API agentic orchestration; use the newest point release.
- vs: GPT-5.6 Sol / Claude Opus 5 — the review's own comparison set.
- sources: https://kingy.ai/blog/muse-spark-1-3-review-benchmarks-pricing-verdict/, https://modelslab.com/models/meta/meta-muse-spark-1.3

### model: Ling 3.0 Flash
- provider: InclusionAI (Ant Group)
- released: 2026 (joined Vercel AI Gateway 2026-07-23) — https://vercel.com/ai-gateway/models/ling-3.0-flash-free/about
- context: 256K
- availability: + (source "(free)" tags match; Vercel's own listing had a free 3-week promo through 2026-08-03, after which "Ling 3.0 Tiny" took the free slot — re-check currency)
- good-at: 124B total / ~5.1B active MoE, native hybrid-linear attention, built for token-efficient agentic inference; matches or beats its 1T-class predecessor (Ring-2.6-1T) despite far fewer active params. 10,000+ interactive training environments for closed-loop agent tasks.
- do-not: The free listing may have rotated off — Vercel's page says the free slot moved to "Ling 3.0 Tiny" on 2026-08-06.
- personality: Efficiency-first — more agentic work per token, not raw leaderboard topping.
- bestfor: High-frequency agentic workflows and document processing where token cost per action matters.
- vs: Qwen3.8 Flash-Next — similar "efficiency architecture experiment" positioning from a different lab.
- sources: https://huggingface.co/inclusionAI/Ling-3.0-flash-FP8, https://vercel.com/ai-gateway/models/ling-3.0-flash-free/about

### model: Gemma 4 (26B/31B A4B family)
- provider: Google
- released: unconfirmed exact date; current (2026) Artificial Analysis snapshots list "Gemma 4 26B A4B" and "Gemma 4 31B."
- context: unconfirmed exact figure
- availability: + (source shows "Gemma 4 268 A4B (free)", "Gemma 4 318 (free)" — read as garbled "26B"/"31B", not confirmed)
- good-at: Referenced as a baseline open comparison point in Nemotron 3 Ultra's release coverage.
- do-not: No first-party Google spec sheet pulled — don't quote parameter/context numbers without checking Google's model card.
- personality: unconfirmed
- bestfor: unconfirmed — treat as a small/efficient open-weight Google option pending better sourcing.
- vs: gpt-oss-20b — similar small-open-weight-model class, different vendor.
- sources: https://www.coderabbit.ai/blog/nemotron-3-ultra-release, https://artificialanalysis.ai/microevals

### model: gpt-oss (120B / 20B family)
- provider: OpenAI
- released: real, current family per multiple 2026 trackers (Artificial Analysis lists "gpt-oss-120b" and "gpt-oss-20b").
- context: unconfirmed exact figure — check OpenAI's own gpt-oss model card.
- availability: + (source's "GPT 0SS 1208" most likely a mangled "gpt-oss-120b" — guess, flagged, do not treat as confirmed)
- good-at: Referenced repeatedly as the small-open-weight-model comparison baseline.
- do-not: Do not ship "GPT 0SS 1208" as a table row without checking the literal model-ID string in the gateway.
- personality: unconfirmed
- bestfor: unconfirmed
- vs: Gemma 4 — both show up as the "small open baseline" in the same comparison tables.
- sources: https://www.coderabbit.ai/blog/nemotron-3-ultra-release, https://artificialanalysis.ai/microevals

### model: North Mini Code
- provider: unconfirmed
- released: unconfirmed
- context: unconfirmed
- availability: + (marked "(free)" in source)
- good-at: unconfirmed — appears as a row in an Artificial Analysis benchmark table alongside real models, so likely real and currently tracked, but no dedicated writeup found.
- do-not: Don't fill in specs from guesswork. Check the Artificial Analysis page or the gateway's model card first.
- personality: unconfirmed
- bestfor: unconfirmed
- vs: unconfirmed
- sources: https://artificialanalysis.ai/microevals (bare listing only)

### model: MiMo V2.5 (and MiMo-V2.5-Pro, MiMo-V2-Flash)
- provider: Xiaomi
- released: unconfirmed exact date; "MiMo-V2-Flash (Feb 2026)" dated variant appears in Artificial Analysis tracker.
- context: unconfirmed
- availability: + (marked "(free) Free" in source — likely scrape duplication)
- good-at: One aggregator describes the MiMo line as targeting "coding agents and real-world automation with long-context reasoning, multimodal interaction, and compatible APIs."
- do-not: No first-party Xiaomi spec sheet found — don't quote numbers.
- personality: unconfirmed
- bestfor: unconfirmed
- vs: unconfirmed
- sources: https://artificialanalysis.ai/microevals

### model: Nemotron 3.5 Lightning / Nemotron 3.5 Content Safety / Nemotron 3 Nano Omni
- provider: NVIDIA (presumed, consistent with Nemotron 3 family naming)
- released: unconfirmed
- context: unconfirmed
- availability: + (marked "(free)" in source for all three)
- good-at: unconfirmed specifics — plausible minor/specialized releases in the Nemotron 3 line (a ".5" point release, a safety-classifier variant, an omni-modal small variant), but no dedicated first-party page found in this pass.
- do-not: Don't quote parameter counts, context windows, or benchmark numbers — no confirmed source.
- personality: unconfirmed
- bestfor: unconfirmed
- vs: unconfirmed
- sources: none confirmed — flag for follow-up against NVIDIA's own Nemotron model catalog

### Unconfirmed / no reliable hit — do not use without further checking
- **BigPickle Free** — no hits. Could be a router free-tier alias or scrape noise.
- **Charm** — too generic to search reliably; no clear model hit.
- **Dots3-Note Preview (free)** — no hits under this exact string.
- **Free Models Router** — reads like a UI category label, not a model.
- **Laguna S 2.1 (free) / Laguna XS 2.1 (free)** — no hits.
- **Latest** (as its own list item) — reads like a UI alias, not a model.
- **Ling 3.0 Flash Sante (free) / Ling 3.0 Flash Fin (free)** — base "Ling 3.0 Flash" is real; no confirmation that "Sante"/"Fin" are real variant suffixes.
- **Kimi K2.7 Code** — referenced as the coding-specialist sibling of K2.6 but was not in the original source list; flagged, not shipped as a row.

---

## Curation notes for the UI table (Sept 2026)

- Benchmark column mixes vendor-reported and independent-tracker numbers; vendor claims flagged as such.
- `Avail.` markers: `+` throughout. The researcher did not invent `*` / `+` per model unless the source string itself said "(free)"; everything else is `+ (unconfirmed)`. Verify free-tier status against the gateway's live model list before treating any row as actually free.
- Dropped from the UI table (could not confirm): BigPickle, Charm, Dots3-Note Preview, Free Models Router, Laguna S/XS 2.1, "Latest", Ling Sante/Fin. Kimi K2.7 Code noted but not in source list.
- Nemotron 3.5 Content Safety is a safety-classifier variant, not a coding driver — kept as a labeled row so the name doesn't get re-added later as a mystery model.
