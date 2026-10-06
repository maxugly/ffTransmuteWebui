"""Frontend contract tests for the pool provenance token grammar (spec §11.3).

These load the real ESM module with Node so the grammar cannot drift from the
implementation without a red test.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GRID_JS = ROOT / "app" / "static" / "js" / "pool" / "grid.js"

NODE = shutil.which("node")

_HARNESS = r"""
const fs = require('fs');
// Minimal DOM/app stubs so grid.js can be imported headlessly.
globalThis.window = globalThis.window || {};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, addEventListener() {}, setAttribute() {}, getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0 }), querySelectorAll: () => [], querySelector: () => null, innerHTML: '', textContent: '', hidden: true, remove() {} }),
  addEventListener: () => {},
  body: { classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, appendChild() {}, style: {} },
  documentElement: { classList: { add() {}, remove() {}, contains: () => false } },
};
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
globalThis.addEventListener = () => {};
globalThis.window.addEventListener = () => {};
globalThis.window.dispatchEvent = () => {};
globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const SRC = fs.readFileSync(process.argv[2], 'utf8');
// Strip the app-level imports; we only need the pure token helpers, which are
// defined in this module. Replace imports with stubs and export the helpers.
const stripped = SRC
  .replace(/^import[\s\S]*?from\s+'[^']*';?$/gm, '')
  .replace(/^import\s+'[^']*';?$/gm, '')
  .replace(/^export\s*\{[\s\S]*?\}\s*;?$/gm, '');
const EXPORTS = `
globalThis.__api = { parsePoolQuery, _normalizeKeyToken, _matchProvenanceToken };
`;
const mod = stripped + EXPORTS;
// eslint-disable-next-line no-eval
(0, eval)(mod);

const cases = JSON.parse(process.argv[3]);
const out = [];
for (const c of cases) {
  let value;
  try {
    if (c.op === 'parse') value = globalThis.__api.parsePoolQuery(c.query);
    else if (c.op === 'key') value = globalThis.__api._normalizeKeyToken(c.key);
    else if (c.op === 'match') value = globalThis.__api._matchProvenanceToken(c.item, c.k, c.v);
    else throw new Error('unknown op ' + c.op);
  } catch (e) {
    value = { __error: String(e && e.message) };
  }
  out.push({ id: c.id, value });
}
process.stdout.write(JSON.stringify(out));
"""


def _run(cases: list[dict]) -> list[dict]:
    harness = ROOT / "junk" / "media_catalog_token_harness.cjs"
    harness.parent.mkdir(parents=True, exist_ok=True)
    harness.write_text(_HARNESS)
    proc = subprocess.run(
        [NODE, str(harness), str(GRID_JS), json.dumps(cases)],
        capture_output=True, text=True, timeout=60, cwd=str(ROOT),
    )
    if proc.returncode != 0:
        raise AssertionError(f"node harness failed: {proc.stderr[-2000:]}")
    return json.loads(proc.stdout)


def _item(**sm):
    return {"source_meta": sm}


@unittest.skipIf(NODE is None, "node not available")
class PoolTokenGrammarTest(unittest.TestCase):
    def test_parse_splits_tokens_from_text(self):
        cases = [
            {"id": "multi", "op": "parse", "query": "is:mine key:Cmaj riff"},
            {"id": "none", "op": "parse", "query": "just text"},
            {"id": "empty", "op": "parse", "query": ""},
            {"id": "colon_only", "op": "parse", "query": "http://x/y.mp4"},
        ]
        out = {c["id"]: c["value"] for c in _run(cases)}
        multi = out["multi"]
        self.assertEqual([t[0] for t in multi["tokens"]], ["is", "key"])
        self.assertEqual([t[1] for t in multi["tokens"]], ["mine", "Cmaj"])
        self.assertEqual(multi["text"], "riff")
        self.assertEqual(out["none"]["tokens"], [])
        self.assertEqual(out["none"]["text"], "just text")
        self.assertEqual(out["empty"]["tokens"], [])

    def test_key_normalization(self):
        cases = [
            {"id": "cmaj", "op": "key", "key": "Cmaj"},
            {"id": "cspace", "op": "key", "key": "c major"},
            {"id": "plain", "op": "key", "key": "C"},
            {"id": "amin", "op": "key", "key": "Amin"},
            {"id": "amin_space", "op": "key", "key": "A min"},
            {"id": "fsharpmin", "op": "key", "key": "F#min"},
            {"id": "fsharpmin_space", "op": "key", "key": "F# min"},
            {"id": "bb", "op": "key", "key": "Bb"},
            {"id": "junk", "op": "key", "key": "H#nope"},
        ]
        out = {c["id"]: c["value"] for c in _run(cases)}
        self.assertEqual(out["cmaj"], "C major")
        self.assertEqual(out["cspace"], "C major")
        self.assertEqual(out["plain"], "C major")
        self.assertEqual(out["amin"], "A minor")
        self.assertEqual(out["amin_space"], "A minor")
        self.assertEqual(out["fsharpmin"], "F# minor")
        self.assertEqual(out["fsharpmin_space"], "F# minor")
        self.assertEqual(out["bb"], "Bb major")
        self.assertIsNone(out["junk"])

    def test_provenance_matches(self):
        mine_hand = _item(is_mine=True, made_by_me=True, ai_involved=True,
                          origin="generated", site="youtube", is_youtube=True,
                          publish_date="2024-02-14")
        plain = _item()
        web = _item(origin="web", site="vimeo", publish_date="2020-01-01")
        cases = [
            {"id": "m1", "op": "match", "item": mine_hand, "k": "is", "v": "mine"},
            {"id": "m2", "op": "match", "item": plain, "k": "is", "v": "mine"},
            {"id": "m3", "op": "match", "item": mine_hand, "k": "is", "v": "hand"},
            {"id": "m4", "op": "match", "item": mine_hand, "k": "is", "v": "ai"},
            {"id": "m5", "op": "match", "item": mine_hand, "k": "is", "v": "youtube"},
            {"id": "m6", "op": "match", "item": mine_hand, "k": "origin", "v": "generated"},
            {"id": "m7", "op": "match", "item": plain, "k": "origin", "v": "generated"},
            {"id": "m8", "op": "match", "item": web, "k": "site", "v": "vimeo"},
            {"id": "m9", "op": "match", "item": mine_hand, "k": "after", "v": "2024-01-01"},
            {"id": "m10", "op": "match", "item": mine_hand, "k": "after", "v": "2025-01-01"},
            {"id": "m11", "op": "match", "item": plain, "k": "before", "v": "2030-01-01"},
            {"id": "m12", "op": "match", "item": plain, "k": "is", "v": "nonsense"},
        ]
        out = {c["id"]: c["value"] for c in _run(cases)}
        self.assertIs(out["m1"], True)
        self.assertIs(out["m2"], False)
        self.assertIs(out["m3"], True)
        self.assertIs(out["m4"], True)
        self.assertIs(out["m5"], True)
        self.assertIs(out["m6"], True)
        self.assertIs(out["m7"], False)
        self.assertIs(out["m8"], True)
        self.assertIs(out["m9"], True)
        self.assertIs(out["m10"], False)
        self.assertIs(out["m11"], False)  # no publish_date → no match
        self.assertIs(out["m12"], True)   # unknown token must not filter anything

    def test_key_token_matching(self):
        item = {"source_meta": {"key_name": "C major"}, "tempo": 128.4}
        cases = [
            {"id": "k1", "op": "match", "item": item, "k": "key", "v": "Cmaj"},
            {"id": "k2", "op": "match", "item": item, "k": "key", "v": "c major"},
            {"id": "k3", "op": "match", "item": item, "k": "key", "v": "F#min"},
            {"id": "k4", "op": "match", "item": item, "k": "key", "v": "garbage"},
            {"id": "b1", "op": "match", "item": item, "k": "bpm", "v": "120-130"},
            {"id": "b2", "op": "match", "item": item, "k": "bpm", "v": "140-150"},
            {"id": "b3", "op": "match", "item": item, "k": "bpm", "v": "128"},
        ]
        out = {c["id"]: c["value"] for c in _run(cases)}
        self.assertIs(out["k1"], True)
        self.assertIs(out["k2"], True)
        self.assertIs(out["k3"], False)
        self.assertIs(out["k4"], True)   # unknown key token must not filter
        self.assertIs(out["b1"], True)
        self.assertIs(out["b2"], False)
        self.assertIs(out["b3"], True)   # 128.4 within 1 of 128


if __name__ == "__main__":
    unittest.main()