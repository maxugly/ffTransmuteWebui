# Video-Model Research Prompt Spec (process spec — not a build ticket)

> **Status:** Process spec. Describes the reusable prompt handed to a research
> model (LLM with web access) to produce one `*_mod_ref.md`-quality brief.
> **Scope cap:** one model or one family per run (e.g. Vidu 1.0 / 1.5 / 2.0 /
> Q2 / Q3 / Q1 — never two vendors in one run). Depth collapses past that.
> **Gold standard:** `docs/flux_mod_ref.md` (FLUX 3 Video — full street brief,
> zero trim). House entry format: `docs/seedance_mod_ref.md`.

---

## 1. What the run produces

One markdown brief with one `### Model` entry per model in the family, each
entry carrying exactly these fields (no more, no fewer):

`released` · `category` · `good-at` · `do-not` · `personality` · `tips` (exactly 3)
· `vs` (competitor comparisons) · `sources` (links, not bare names)

That brief then maps 1:1 onto the Big Chart schema in
`mtapi-project/app/static/js/tabs/references.js` (`MODELS_COLS`): Model /
Category / Released (+ Rel Date / Rel Note) / Native Training Res (+ Native
W / H / Note) / Sweet Spot (+ Sweet W / H / Note) / Max Output (+ Max W / H /
FPS / Note, Upscaled) / tier badges 480p / 540p / 720p / 1080p / 2K / 4K /
Duration Sweet Spot (+ Dur Min / Max / Note) / True FL2V (`yes`/`?`/`no`) /
Audio (`yes`/`?`/`no`) / Strengths / Weaknesses / Use-Prompt Tips / Notes.
Full column list: `docs/video-table-split-spec.md` §2.

---

## 2. The prompt (hand this to the research model verbatim, filling the brackets)

```text
Research the [VENDOR + MODEL / FAMILY, e.g. "ShengShu Vidu Q-series and 1.0 line"]
AI video model(s) and write a power-user cheat sheet. Today is [DATE — use the
current year in all searches].

SOURCES (use all of them, cite with links):
1. Primary: vendor launch pages, API docs / API catalog listings, wrapper docs
   (fal, Replicate, Segmind, etc.).
2. Street: Reddit r/aivideo + adjacent subs, creator forums, YouTube reviews,
   Threads / X creator threads, Artificial Analysis battles where present.
3. Benchmarks: vendor-claimed win rates AND third-party/community results.
   If a number is labeled "preliminary" or "early candidate" by the vendor,
   say so — never present it as the shipping model.

PER MODEL, report ALL of the following (nothing is optional, nothing gets
summarized away):
- Announcement/release date, access state (open weights? gated? playground
  trial windows with end dates), model/endpoint IDs as listed in API catalogs
  (e.g. flux_3_video, viduq1-start-end).
- Training resolution if published; if NOT published, say "never published"
  and report what resolution early evaluations actually ran at.
- RESOLUTION REPORTING (feeds the split columns — be mechanical about this):
  report width and height as SEPARATE numbers for native-train, working
  sweet-spot, and max output (e.g. "native 768x512" → W 768 / H 512, never
  "768x512" as one blob). State tier coverage explicitly (480p / 540p /
  720p / 1080p / 2K / 4K — which tiers does it natively train or directly
  output?). Report upscaled figures SEPARATELY with the path
  (e.g. "4K via external upscaler" — never mixed into max-output numbers).
  Report max FPS and duration range as min–max seconds (keep frames/fps
  detail alongside). For EVERY resolution figure cite TWO provenances where
  possible: (1) manufacturer/vendor docs, (2) a third-party generation-site
  listing (fal / Replicate / Segmind / API catalog) — link both. If only an
  assumption is possible (bare "1080p" with no dimensions), state the
  assumption explicitly ("assumed landscape 1920x1080") — never silently.
- Sweet spot: cheap-draft tier vs full tier with BOTH prices in $/sec AND
  credits/sec (collect every conflicting figure you find — list them all,
  don't average them). Best duration + resolution + subject count + motion
  speed for physics/coherence, with the failure threshold (e.g. "drift after
  ~12s", "hands break past 15s").
- Max output: longest single generation, max resolution, 4K yes/no, audio
  yes/no. Duration sweet spot split: testing length vs delivery length.
- True FL2V: start+end frame support (endpoint + param names) vs start-frame
  only. If a side-by-side test shows it failing (blurry cut, morph), report
  the failure, not the feature list.
- Audio: native synchronized out (dialogue/SFX/music in one pass?) vs silent.
  External audio INPUT accepted or output-only? Lip-sync quality in street
  words. Multilingual behavior if reported.
- Strengths: only things creators demonstrably like, with the receipts
  (quotes + who said it).
- Weaknesses: the raw street take — where marketing falls apart. Losing
  matchups vs named competitors, censorship limits, physique/rendering
  complaints, credit burn, gated access anger. Quote directly, attribute
  (subreddit, thread, "Threads comment"). NEVER soften this section.
- Exactly 3 practical prompting tips per model (how to DRIVE it: timestamp
  brackets, reference-slot discipline, negative-prompt workarounds, draft-then-
  enhance discipline) — not brochure copy.
- vs: head-to-head outcomes vs named competitors (who wins at what).

RULES:
- Zero marketing buzzwords. No "cutting-edge", "revolutionary", "stunning".
- Concrete numbers or it didn't happen: $/s, credits/s, resolutions, seconds,
  frame counts, aspect-ratio guards, slot counts, VRAM.
- Conflicting street figures are DATA — report every figure with its source,
  never reconcile them into one number.
- Unknown cells stay unknown: FL2V/Audio unconfirmed → "?" with a
  "needs human verify" note. NEVER invent a spec to fill a gap.
- Unverified vendor claims (announced-but-not-in-API 4K, etc.) get flagged
  "announced, unverified" — never stated as fact.
- COMPLETENESS OVER BREVITY. You do not decide what to filter out. Every
  price, quote, number, caveat, and failure mode you find ships in the brief.
  A long entry is correct; a trimmed entry is a failed run.
```

---

## 3. Acceptance checklist (reviewer runs this before the brief ships)

- [ ] One family max; every model in the family has all 8 fields.
- [ ] `tips` is exactly 3 per model, all actionable driving instructions.
- [ ] Every price appears in original units ($/s and/or credits/s), with source; conflicts listed, none averaged.
- [ ] Weaknesses section names competitors, quotes street voices with attribution, unsoftened.
- [ ] Vendor win-rate claims carry their provenance label (preliminary vs shipping vs third-party).
- [ ] Endpoint/model IDs spelled exactly as catalogs list them.
- [ ] Unconfirmed FL2V/Audio cells are `?` + verify-note, not guesses.
- [ ] `sources` are links, covering primary + street + benchmark.
- [ ] Entry maps cleanly onto all Big Chart columns with no information left homeless.
- [ ] Resolutions reported as split W/H per context + explicit tier coverage + upscaled figures separated with path; manufacturer AND third-party gen-site refs present per figure (or assumption explicitly stated).

---

## 4. Anti-trim law (why this spec exists)

The FLUX 3 Video brief (`docs/flux_mod_ref.md`) only reached reference quality
because the human hand-passed the full text after models kept "helpfully"
summarizing away prices, quotes, and caveats. Trimming is data loss.
Any run that drops a found price, quote, number, or failure mode to "keep it
concise" fails acceptance regardless of how polished it reads.
