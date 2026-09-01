# Spec: Random Word Generator (RWG) + MadLib seed

> **Status:** Proposed — ready to build on human priority.
> **Audience:** Builder (backend + frontend), Reviewer.
> **Code targets:** `mtapi-project/app/operations/rwg_ops.py` → `POST /ops/rwg` ·
> `mtapi-project/app/static/js/tabs/rwg.js` · `mtapi-project/app/static/css/rwg.css` ·
> `mtapi-project/tests/test_rwg.py`
> **Related:** `prompt-library-spec.md` (curve toward manual template reuse),
> `universal-prompt-module-spec.md` (blank = seed pattern).
> **Non-goal, this turn:** the full MadLib surface. This spec ships the **lexicon +
> category sampler** and an MVP "pick a category → get a word" single-shot; the
> template engine is sketched (§7) so it evolves cleanly, but is not built here.
>
> **Revision history:**
> - **v2:** per human — *trade "exhaustive" for a clean, well-defined list of
>   "most of them."* Data moves from a runtime corpus to **static per-category
>   list files, baked once at build time** (§2).
> - **v3:** per human — proper nouns must be **culturally/encyclopedically
>   notable** (famous & historical people, real countries/cities), not phone-book
>   names. Source switched to **Wikipedia's structured layer, Wikidata**
>   (SPARQL at build time; notability = has a Wikipedia article; CC0). Phone-book
>   given/surname/full-name categories dropped; person / famous_person /
>   by-occupation / country / city added (§2.4, §3.1).

---

## 1. Goal

A deterministic, **no-LLM** random **category word generator**. The user picks a
category — noun / verb / adjective / adverb / person / famous person / scientist /
musician / writer / monarch / athlete / artist / country / city — and gets one
(or N) random entries, optionally seed-seeded for reproducibility. The same
backend grows into a **MadLib machine**: a template text with `{noun}` / `{adj}` /
`{adverb:verb}` / `{famous_person}` / `{city}` blanks that the sampler fills.

**The contract that matters:** each category is a **static, cleanly-defined list
of "most of them."** No corpus parsing at request time, no network, no LLM. The
server loads each list once at startup into a `list[str]`, reports `len()`, and a
sampler picks from it. That is the whole engine — trivially correct,
introspectable, and deterministic.

> **On "exhaustive":** an exhaustive English lexicon does not exist (proper
> nouns, neologisms, inflected forms, technical vocabulary are all open sets).
> We deliberately **trade exhaustive for clean-and-most** per the human: a finite,
> deduplicated, POS/semantics-correct list per category, big enough to feel rich,
> small enough to be *fully owned and verifiable*. "How many are there?" always
> has a real, exact answer (the file's line count).

---

## 2. Data model: static list files (the "clean, well-defined list")

### 2.1 The shape of every category

One **plain text file per category**, stored under `mtapi-project/app/rwg/data/`:

```
app/rwg/data/
  nouns.txt          # one entry per line
  verbs.txt
  adjectives.txt
  adverbs.txt
  people.txt         # e.g. "Benjamin Franklin"
  famous_people.txt  # e.g. "Ada Lovelace"
  scientists.txt     # e.g. "Marie Curie"
  musicians.txt      # e.g. "Ludwig van Beethoven"
  writers.txt        # e.g. "Virginia Woolf"
  monarchs.txt       # e.g. "Elizabeth I"
  athletes.txt       # e.g. "Simone Biles"
  artists.txt        # e.g. "Frida Kahlo"
  cities.txt         # e.g. "Lisbon"
  countries.txt      # e.g. "Bhutan"
```

**File contract (non-negotiable, this is what "cleanly defined" means):**
- Plain UTF-8; **one entry per line**; no leading/trailing whitespace; no dupes.
- Common nouns lowercase (`dog`); proper nouns title-cased (`Mara`, `Lisbon`).
- Single token only for the MVP (no spaces). Multiword proper nouns (e.g.
  *Buenos Aires*, *New York*) are a *named* follow-up (§7), not a silent surprise.
- A closing newline; blank lines rejected at load.
- Every file is **owned and committed** — `git diff` shows exactly what you would
  sample from. No hidden dynamic source.

**Loader:** read once at startup → `dict[str, list[str]]` (module global). Each
file's line count IS its `pool_size`; sampled lists are just `random.Random(seed)
.choice/.sample`. This is the whole engine.

### 2.2 Why bake files instead of a runtime corpus?

The previous draft used WordNet via NLTK at runtime. Clean and POS-guaranteed,
but: ~40 MB parsed per run, an NLTK dependency, and — the dealbreaker for the
human's reframe — it makes "exhaustive" a moving, un-owned corpus. Baking files
at **build time** gives the same content with none of that:

- **Zero runtime deps**, zero network, instant first draw, tiny memory.
- **Ownable/verifiable** — one `git diff` shows every word.
- **Deterministic counts** — `pool_size` is literally the line count.

The corpus is only a *one-time* build input (see regeneration script, §4.3),
not a runtime thing.

### 2.3 Common parts of speech — build sources

These are the "clean and most" lists. Build them **once, offline**, into the
files above via a checked-in script, so the baked files stay reproducible.

- **Primary: WordNet lemmas via NLTK** (offline, hand-curated, POS-tagged). This
  is the single best source for "noun / verb / adjective / adverb" because every
  lemma carries its POS:
  ```python
  from nltk.corpus import wordnet as wn
  nouns      = sorted(set(wn.all_lemma_names(pos=wn.NOUN)))
  verbs      = sorted(set(wn.all_lemma_names(pos=wn.VERB)))
  adjectives = sorted(set(wn.all_lemma_names(pos=wn.ADJ)) | set(wn.all_lemma_names(pos=wn.ADJ_SAT)))
  adverbs    = sorted(set(wn.all_lemma_names(pos=wn.ADV)))
  ```
  Then clean each to the file contract: `_`→space and **drop** any entry that
  still has a space or apostrophe, drop lowercase-only proper duplicates, drop
  profanity (denylist), and — per the "most of them" trade — **optionally cap**
  by leaving the full set or trimming to the most common (see §2.5).
  NLTK is a **build-time-only** tool; it is not a runtime dependency.
- **Alternative if we want "most common" over "most":** a curated frequency list
  (see §2.5) replaces or caps the WordNet set.

**Decision (primary):** bake **full WordNet lemma sets** (cleaned) as the v1
POS files. They are clean, POS-guaranteed, and "most of them" in spirit —
hundreds of thousands of tokens across the four categories. Frequency trimming is
a later knob, not a v1 gate.

### 2.4 Proper nouns — build sources (the names & places question)

WordNet is essentially **useless for proper nouns**: it tags only ~7.7 K
"instance" synsets (a scattering of famous people/places) and even the
literature concedes this coverage is incomplete and inconsistent. **Proper nouns
need dedicated datasets.** All are open, clean, non-LLM:

**The answer: use Wikipedia's structured knowledge layer — Wikidata.**

The human's instinct is correct: culturally-notable entities come from an
*encyclopedia*, not a phone book. **Wikidata** is the machine-readable database
behind Wikipedia — every famous/historical person, real country, and notable city
has a stable ID (QID) with typed properties (class, dates, occupation, country).
It is:

- **notability-encoded** — the clean definition of "in culture" is simply
  *"this entity has a Wikipedia article."* Filters can require ≥ a number of
  language sitelinks for "famous" vs "any article" for "broad".
- **cleanly defined** — each entity has English label, instance-of class
  (human = `Q5`, sovereign state = `Q3624078`, city = `Q515`), and rich qualifiers
  (occupation `P106`, country `P17`, sex `P21`, …).
- **no LLM** — fetched via **SPARQL** (a declarative query language) from the
  **Wikidata Query Service** (`query.wikidata.org/sparql`), exported as TSV/CSV
  at **build time**, then baked into the same static `.txt` files.
- **huge — "as much as we can get."** The full dump holds ~100 M+ entities
  (millions of humans, hundreds of thousands of cities, all 190+ sovereign
  states). Exactly the "max coverage" the human wants; disk is a non-issue.
- **CC0-licensed** — public domain; no attribution or share-alike obligations
  (simpler and cleaner than ODbL). Still record the source in `data/README.md`.

**People (famous & historic, not phone book):**
- `person` — every human (`wdt:P31 wd:Q5`) with an English Wikipedia article
  (`?article schema:about ?x ; schema:isPartOf <https://en.wikipedia.org/>`).
  This is "everyone notable enough for an encyclopedic entry."
- `famous_person` — the same, **ranked/filtered by sitelink count** (a standard
  notability proxy), e.g. `wikibase:sitelinks ?n` with `?n >= N`. Tune N to taste
  ("most famous" vs "notable").
- **By field/occupation** (`wdt:P106 <occupation QID>`) → power MadLib slots:
  `scientist`, `musician`, `writer`, `ruler/monarch`, `athlete`, `artist`,
  `inventor`, `philosopher`. Each is just another SPARQL filter over `Q5`.
- (Optionally `given`/`surname` derived from labels of these people — see §7's
  name-composition note. Not required for v1.)

**Places (real, encyclopedic):**
- `country` — `wdt:P31 wd:Q3624078` (sovereign state) → the essentially-closed
  set of ~190–250 real countries, English labels.
- `city` — `wdt:P31 wd:Q515` (city) with an article, English labels →
  hundreds of thousands of real, noted cities.
- `state` (optional) — `wdt:P31 wd:Q35657`/`Q7275` etc. (region/state/province) —
  a follow-up if wanted.
- Optionally filter places by `wdt:P17` (country) for region-scoped outputs later.

**Reference query** (People with an English Wikipedia article, ranked by fame):

```sparql
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd:  <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
PREFIX wikibase: <http://wikiba.se/ontology#>

SELECT DISTINCT ?item ?itemLabel (?article AS ?url) ?sitelinks
WHERE {
  ?item wdt:P31 wd:Q5 .                      # is a human
  ?article schema:about ?item ;
           schema:isPartOf <https://en.wikipedia.org/> .   # has an EN article
  ?item wikibase:sitelinks ?sitelinks .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?sitelinks)
```

Similar shapes with `wd:Q3624078` (country) / `wd:Q515` (city) for places, and an
extra `?item wdt:P106 wd:<occupation>` triple for field-scoped people.

**Fetch mechanism (build-time only):** small checked-in script
(`build_lists.py`) calls the WDQS HTTP endpoint with `format=tsv` and writes
`app/rwg/data/*.txt` — or, for the full haul, pulls the official **Wikidata
dump** (`wikidata-*-all.json.gz`) into scratch and extracts labels/classes
locally. Both are offline, deterministic, non-LLM; the server never talks to
Wikidata.

**License note:** Wikidata is **CC0** (public domain) — no attribution or
share-alike requirement. Record source + build date in `data/README.md` anyway.

### 2.5 Frequency weighting (optional, later)

The human's reframe removes the pressure to be exhaustive, so we can also relax
uniform sampling if output feels too odd. Two cheap knobs, both later:
- **Cap-to-common:** trim a POS file to its N most frequent members (via a
  frequency list such as `wordfreq` / COCA top-N). Baking N directly into the
  file keeps sampling uniform-over-common — no runtime weighting math.
- **Corpus weighting at runtime** via `wordfreq` — **not needed for v1**; only
  if uniform-over-big feels too weird.

### 2.6 Absent/adjacent sources (noted, not adopted)

- **CMU Pronouncing Dictionary** (~134 K pronunciations) — **no POS/type tags** →
  useless for categories; keep in mind only for a *rhyming / foreign-accented*
  MadLib later.
- **Scrabble word lists (TWL / SOWPODS)** — valid words, **no POS**, gaming-skewed.
- **Online static word-list repos** (`/usr/share/dict/*`, `words.txt` on GitHub) —
  mixed quality, often no POS; pre-set usages (`a`, `the`) pollute nouns. Skip.
- **LLMs / word-as-a-service** — explicitly excluded per the human.

**Decision (v2):** bake **static per-category files** from WordNet (common POS) +
**Wikidata** (proper nouns: famous/historic people, occupations, real countries,
cities). No runtime corpus, no network, no LLM. "Clean, well-defined, as much as
we can get, requestable at will."

---

## 3. Attribute model & parameters

### 3.1 Categories (v1)

| `pos` key  | Data file            | Source (built once)                     | Case   |
|------------|----------------------|-----------------------------------------|--------|
| `noun`         | `nouns.txt`      | WordNet NOUN lemmas (cleaned)                | lower |
| `verb`         | `verbs.txt`      | WordNet VERB lemmas (cleaned)                | lower |
| `adjective`    | `adjectives.txt`| WordNet ADJ + ADJ_SAT lemmas (cleaned)       | lower |
| `adverb`       | `adverbs.txt`    | WordNet ADV lemmas (cleaned)                 | lower |
| `person`       | `people.txt`     | Wikidata `Q5` humans w/ EN article             | Title |
| `famous_person`| `famous_people.txt` | Wikidata `Q5` ranked by sitelinks ≥ N       | Title |
| `scientist`    | `scientists.txt`| Wikidata `Q5` + occupation `Q901`             | Title |
| `musician`     | `musicians.txt` | Wikidata `Q5` + occupation `Q639669`          | Title |
| `writer`       | `writers.txt`   | Wikidata `Q5` + occupation `Q36180`           | Title |
| `monarch`      | `monarchs.txt`  | Wikidata `Q5` + occupation `Q116`             | Title |
| `athlete`      | `athletes.txt`  | Wikidata `Q5` + occupation `Q2066131`         | Title |
| `artist`       | `artists.txt`   | Wikidata `Q5` + occupation `Q483501`          | Title |
| `country`      | `countries.txt` | Wikidata `Q3624078` (sovereign state), EN label | Title |
| `city`         | `cities.txt`    | Wikidata `Q515` (city) w/ EN article          | Title |
| `state`        | `states.txt`    | Wikidata region/state (deferred)              | Title |

> Occupation QIDs (`Q901` scientist, `Q639669` musician, `Q36180` writer,
> `Q116` monarch, `Q2066131` athlete, `Q483501` artist) are build-time SPARQL
> constants — swap/extend freely; add more fields as MadLib needs grow.

**Deferred (v2):** `pronoun`, `preposition` (tiny **closed** classes — best as a
short hand-curated file; not worth a source). Also `given`/`surname` (derivable
from person labels), `county`, `river`, `mountain`, region-scoped
`city:italy`, `famous_person` threshold tuning, etc.

**Multi-token:** proper-noun entries (people, cities, countries) are naturally
multiword (`"Ada Lovelace"`, `"New York City"`). The §2.1 single-token contract
**does not bind these categories** — they store the full display label. Common-POS
files stay single-token.

**Every category now has a backing file.** `pool_size` / `sampled_from` are always
the plain line count of the file (after `min_len`/`max_len`/`denylist`). No
composed categories in v1.

### 3.2 Request → response

```jsonc
POST /ops/rwg
{
  "pos": "famous_person",  // any key from §3.1
  "count": 1,             // 1..50, default 1
  "seed": null,           // int|null; null = non-reproducible draw
  "min_len": 1,           // optional min chars (single-token categories only)
  "max_len": 32,          // optional max chars
  "denylist": []          // extra entries to exclude for this call
}
```

```jsonc
// 200
{
  "ok": true,
  "pos": "famous_person",
  "words": ["Ada Lovelace"],
  "pool_size": 123456,      // file line count after build
  "sampled_from": 123400,   // after min_len/max_len/denylist
  "seed": 9001              // echoed; the seed actually used (null→random int)
}
```

### 3.3 Sampling & determinism

- Use `random.Random(seed)` **per request**; never the shared global RNG.
- `seed is None` → draw a Python `random.SystemRandom().randrange(...)` and echo
  it back, so any produced output is *reproducible-by-seed* after the fact.
- Same `(pos, seed, filters)` ⇒ same ordered `words` list, guaranteed.
- `count` draws are **with replacement** unless `count > len(sampled_pool)`, in
  which case it's silently capped to `len(sampled_pool)` (no infinite dup loop).
- `min_len`/`max_len` filter the in-memory list, then sample; the reported
  `sampled_from` reflects the filtered size.
- `denylist` entries are exact-string matches removed before sampling.

### 3.4 Denylist

Ship one built-in denylist (profanity / slurs; one per line,
`app/rwg/denylist.txt`). Applied at load and merged per-request. Common-noun
files are filtered at **build time** too, so the baked file is already clean.

---

## 4. Backend shape

- **No video / ffmpeg / neural involvement.** This is a stateless generator; it
  does **not** touch `dump → filters → encode`. The Filter Platform contract does
  not apply.
- **Load once at startup:** read every `.txt` under `app/rwg/data/` into a
  `dict[str, list[str]]` module global (reject blank lines / dupes; a malformed
  file fails fast at boot). Warm in `app/main.py` startup.
- **No runtime dependency.** NLTK / SPARQL / Wikidata are **build-time only** —
  never imported by or called from the server.
- Reuse existing op conventions: `OperationResult` return shape, failures are
  **HTTP 200 + `{"ok": false}`** (a bad `pos` string, `count` out of range, etc.).
- Thin wrapper pattern from `staged_job` does **not** apply (no staging); this op
  is just validate → sample → `OperationResult`.

### 4.3 Build / regeneration script (build-time, in `app/rwg/`) 

A checked-in script regenerates the baked files from upstream sources, so the
data is reproducible and audit-able:

- `build_lists.py` — pulls WordNet (via a temp NLTK download **into a `junk/` or
  `/tmp` scratch dir**, never into the repo) for the four POS files; queries the
  **Wikidata Query Service** (SPARQL → TSV) for the person / occupation / country /
  city proper-noun files (or extracts from the Wikidata dump, also into scratch);
  applies the cleaning contract + denylist; writes `app/rwg/data/*.txt`.
  It is a **Make-style dev tool**, not a runtime path.
- `app/rwg/data/README.md` — records each file's upstream source, license
  (WordNet 3.0; **Wikidata CC0**), the SPARQL queries used, build date, and line
  count. Required so the baked files stay reproducible & properly attributed.
- **Rule:** the baked `.txt` files are the runtime artifact; the script only
  exists to regenerate them offline and is never called by the server.

---

## 5. Frontend (vanilla SPA tab) — MVP

New tab **"MadLib"** (or "Words") in `app/static/js/tabs/rwg.js` + `rwg.css`.
Purist vanilla ES6; no framework (invariant #7).

```
[ MadLib / Random Word Generator ]

Category:     ( noun )  verb  adjective  adverb
              person  famous person  scientist  musician  writer
              monarch  athlete  artist  country  city
Min len [ ]  Max len [ 32 ]      Count: [ 1 ]
Seed: [ ______ ] (blank = random)
[ Roll ]                                          [ ↩ Copy list ]

─ results ─────────────────────────────────
  Ada Lovelace
  (pool: 123,456  ·  seeded 9001)
──────────────────────────────────────────
```

- **Category picker** is the only structural control: a **common-POS group**, a
  **people group** (person / famous person / by-occupation), and a **places group**
  (country / city). A segmented control or grouped `<select>`.
- **`Roll`** hits `/ops/rwg`, renders entries, and shows the file's line count
  (`pool: 123,456`) plus the echoed seed. Ctrl/Cmd+Click or a small per-entry
  **copy** to clipboard; "Copy list" copies all as newline-joined text.
- **Seed field** follows the `universal-prompt-module-spec.md` convention:
  blank = random, number = reproducible. Echo the real seed under the results.
- **Clearable ✕** on the Seed text box via `data-clearable` (the shipped
  `js/ui/clearable.js` module) — keeps it consistent with every other text box.
- When count > ~8 show a compact list, not a wall.

---

## 6. Definition of done (MVP)

- [ ] `app/rwg/data/*.txt` exist for all ten categories (§3.1), clean per the file
      contract; `data/README.md` attributes each source + license + line count.
      The regeneration script exists and is a build-time tool only; **no NLTK/
      runtime dependency in the server**.
- [ ] Server loads all files at startup; malformed file (blank line, dup) fails
      fast at boot.
- [ ] `POST /ops/rwg` returns `words` for every category; `pool_size` is a real
      computed value (file line count).
- [ ] `seed` reproducibility: same `(pos, seed, filters)` → identical ordered list;
      nullable seed echoes back a real seed.
- [ ] `min_len`/`max_len`/`denylist` filter before sampling and are reflected in
      `sampled_from`.
- [ ] Unit tests (`tests/test_rwg.py`): each file nonempty & count equals its
      `pool_size`; single entry; count=N; seed determinism; proper-noun entry
      sanity (a sample from `people.txt` is a real capitalized multiword label,
      `countries.txt` has no blank/control chars); `min_len`/`max_len`; denylist;
      unknown `pos` → `ok:false`; `count` out of range → `ok:false`.
- [ ] Playwright UI proof: click **Roll** across a common-POS and a proper-noun
      category → real entries render, count renders, copy operates. (Curl is not
      UI proof — invariant #12.)

---

## 7. Evolution: MadLib machine (sketch — NOT this turn)

Same backend, additive. Desired so the MVP is a clean stepping stone:

1. **Template blank syntax:** `{noun}`, `{verb}`, `{adj}`, `{adverb}` for common
   POS plus the proper-noun blanks — `{person}`, `{famous_person}`, `{scientist}`,
   `{musician}`, `{writer}`, `{monarch}`, `{athlete}`, `{artist}`, `{city}`,
   `{country}` — and cross-derivation like `{adverb:verb}` later.
2. **Agreement / inflection (optional):** map a `{noun}` to plural when preceded
   by context, conjugate `{verb}` to tense via the **inflect** package —
   still no LLM, purely rule-based.
3. **Constraint slots:** `{noun:countable}`, `{adj:color}`, `{verb:past}` using
   WordNet lexicographer files / syntactic markers baked into the build; later
   `{scientist:woman}` via Wikidata sex (`P21`) or `{city:italy}` via country
   (`P17`).
4. **Name decomposition (optional):** derive `{given}` / `{surname}` by splitting
   `person` labels — a cheap approximation of first/last name without a separate
   source. Use only if MadLibs want parts of a name, not for `person`.
5. **Region / era scopes** from Wikidata qualifiers (`P27` country, `P569` birth
   year) for themed draws if the creative need grows.
6. **Saveable templates:** mirror `prompt-library-spec.md` (`localStorage`
   `mtapi_madlib_templates`), so template text becomes a reusable asset like
   SD prompt ± pairs.
7. **Seeded runs:** same template + same phrase seed ⇒ identical filled text
   (great for deterministic creative loops in video project names / placeholder
   overlays).

The RWG op is literally the sampling core of #1–#5; nothing here changes the
lexicon source or the no-LLM rule.

---

## 8. Open questions for the human (decide when prioritizing)

1. **"Famous" threshold N.** `famous_person` uses sitelink-count ≥ N. Where to
   draw the line (e.g. N=2 "notable" vs N=10 "world-famous")? Default proposed:
   keep `person` (any article) unbounded and ship `famous_person` at a
   conservative N so both tiers exist.
2. **Enumerated occupations.** Which field lists to bake first — suggested
   `scientist / musician / writer / monarch / athlete / artist` in §3.1. Add or
   drop any? More fields = richer MadLib slots but more bake time.
3. **Bake via WDQS API vs the full dump.** Query Service (fast, curated endpoint,
   but bounded result sets) vs full `wikidata-*-all.json.gz` dump (unbounded, ~
   tens of GB to process into scratch). Recommend WDQS for v1 ("as much as we can
   get" within its practical 1 M-row cap), dump only if the human wants *every*
   city/human.
4. **Generate just words, or a 1-clause MadLib on the MVP tab?** The spec ships
   *word-only* and sketches templates. Pulling a template box into the first
   build is §7–1 (moderate scope +).
5. **Regeneration convenience:** auto-run `build_lists.py` in CI (reproducible
   data, but needs upstream network in CI) or keep it fully manual/offline?
   Recommend manual + committed data for v1.
