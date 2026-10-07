"""Contract tests for the CDP pipeline model (spec: docs/cdp-integration-spec.md §5).

The pipeline type graph and the save/load round-trip are the Phase-2
acceptance backbone ("a 4-step recipe re-runnable from saved JSON"), so they
are pinned in Node against the real ESM modules — not against a reimpl.
Run with the project venv: .venv/bin/py.test tests/test_cdp_pipeline_model.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS_JS = ROOT / "app/static/js/cdp/tools.js"
PIPELINE_JS = ROOT / "app/static/js/cdp/pipeline.js"
VENDOR = ROOT / "app/static/vendor/cdp-wasm-0.7.0/src/index.js"

NODE = shutil.which("node")

_HARNESS = r"""
// `node --input-type=module -e` puts payloads straight after argv[0], so the
// four payloads ARE the last four argv entries — no leading element to skip.
const [effectsPath, toolsPath, pipelinePath, casesJson] = process.argv.slice(-4);
const { buildCatalog, mergeTools, parseManUsage, argvPreview, resolveArgv, usageFromEffect } = await import('file://' + toolsPath);
const {
  newUid, newPipeline, newStep, stepInType, stepOutType,
  validatePipeline, slimStep, pipelineToJSON, pipelineFromJSON, PIPELINE_SCHEMA,
} = await import('file://' + pipelinePath);
const effects = (await import('file://' + effectsPath)).EFFECTS;
const cases = JSON.parse(casesJson);
const out = [];
for (const c of cases) {
  let value;
  try {
    if (c.op === 'catalog') {
      const { curated, raw, missing } = buildCatalog(effects);
      value = { curated: curated.length, raw: raw.length, missing };
    } else if (c.op === 'validate') {
      value = validatePipeline(c.pipeline, new Map(c.tools), c.opts || {});
    } else if (c.op === 'types') {
      const tools = new Map(c.tools);
      value = c.ids.map((id) => {
        const t = tools.get(id);
        return [stepInType(t), stepOutType(t)];
      });
    } else if (c.op === 'roundtrip') {
      const p = pipelineFromJSON(c.json);
      value = { name: p.name, steps: p.steps.length, enabled: p.steps.map(s => s.enabled !== false),
                unknown: p.unknown, again: pipelineToJSON(p) };
    } else if (c.op === 'roundtrip_fail') {
      try { pipelineFromJSON(c.json); value = 'accepted'; }
      catch (e) { value = String(e.message); }
    } else if (c.op === 'slim') {
      const tools = new Map(c.tools);
      value = slimStep(c.step, tools.get(c.step.toolId));
    } else if (c.op === 'man') {
      value = parseManUsage(c.roff);
    } else if (c.op === 'argv') {
      value = argvPreview(c.tool, c.values);
    } else if (c.op === 'merge_tools') {
      value = mergeTools(effects).tools.map((t) => t.id);
    } else if (c.op === 'newstep') {
      const tools = new Map(c.tools);
      value = newStep(tools.get(c.toolId));
    } else {
      throw new Error('unknown op ' + c.op);
    }
  } catch (e) {
    value = { __error: String(e && e.message) };
  }
  out.push({ id: c.id, value });
}
process.stdout.write(JSON.stringify(out));
"""


def _run(cases: list[dict]) -> list[dict]:
    proc = subprocess.run(
        [NODE, "--input-type=module", "-e", _HARNESS, "--",
         str(VENDOR), str(TOOLS_JS), str(PIPELINE_JS), json.dumps(cases)],
        capture_output=True, text=True, timeout=60, cwd=str(ROOT),
    )
    if proc.returncode != 0:
        raise AssertionError(f"node harness failed: {proc.stderr[-2000:]}")
    return json.loads(proc.stdout)


def _tool(tid, kind="effect", in_ext="wav", out_ext="wav", inputs2=False):
    return [tid, {"id": tid, "kind": kind, "program": tid.split('.')[0],
                  "inExt": in_ext, "outExt": out_ext,
                  "inputs": 2 if inputs2 else 1, "inputs2": inputs2,
                  "params": []}]


@unittest.skipIf(NODE is None, "node not available")
@unittest.skipUnless(VENDOR.is_file(), "cdp-wasm not vendored (run scripts/update_cdp_wasm.sh)")
class TestCdpPipelineModel(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # one harness round-trip per test keeps failures local
        pass

    def run_cases(self, cases):
        return {c["id"]: c["value"] for c in _run(cases)}

    def test_full_catalog_shapes(self):
        r = self.run_cases([
            {"id": "catalog", "op": "catalog"},
            {"id": "merge", "op": "merge_tools"},
        ])
        self.assertEqual(r["catalog"]["curated"], 232)
        self.assertEqual(r["catalog"]["raw"], 5)
        self.assertEqual(r["catalog"]["missing"], [])
        for want in ["modify.speed", "blur.blur", "envel.dovetail"]:
            self.assertIn(want, r["merge"])

    def test_four_step_recipe_type_graph(self):
        # spec §9 Phase-2 acceptance: pvoc anal → stretch → blur → synth
        tools = [
            _tool("pvoc.anal", "raw", "wav", "ana"),
            _tool("raw.stretch.time", "raw", "ana", "ana"),
            _tool("raw.blur.blur", "raw", "ana", "ana"),
            _tool("pvoc.synth", "raw", "ana", "wav"),
        ]
        pipeline = {
            "name": "recipe", "inputPath": "/x.wav", "input2Path": "", "steps": [
                {"uid": "a", "toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True},
                {"uid": "b", "toolId": "raw.stretch.time", "kind": "raw",
                 "values": {"factor": 2}, "enabled": True},
                {"uid": "c", "toolId": "raw.blur.blur", "kind": "raw",
                 "values": {"windows": 20}, "enabled": True},
                {"uid": "d", "toolId": "pvoc.synth", "kind": "raw", "values": {}, "enabled": True},
            ],
        }
        r = self.run_cases([
            {"id": "v", "op": "validate", "pipeline": pipeline, "tools": tools},
            {"id": "t", "op": "types", "tools": tools,
             "ids": ["pvoc.anal", "raw.stretch.time", "raw.blur.blur", "pvoc.synth"]},
        ])
        self.assertTrue(r["v"]["ok"], r["v"])
        self.assertEqual(r["v"]["outType"], "wav")
        self.assertEqual(r["t"], [["wav", "ana"], ["ana", "ana"], ["ana", "ana"], ["ana", "wav"]])

    def test_type_mismatch_names_the_fix(self):
        tools = [_tool("pvoc.anal", "raw", "wav", "ana"), _tool("pvoc.synth", "raw", "ana", "wav")]
        pipeline = {
            "name": "bad", "steps": [
                {"uid": "a", "toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True},
                {"uid": "b", "toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True},
            ],
        }
        r = self.run_cases([{"id": "v", "op": "validate", "pipeline": pipeline, "tools": tools}])
        self.assertFalse(r["v"]["ok"])
        msg = r["v"]["errors"][0]["message"]
        self.assertIn(".ana", msg)
        self.assertIn("pvoc synth", msg)  # the concrete fix, not a generic error

    def test_curated_spectral_step_expects_wav(self):
        tools = [
            _tool("pvoc.anal", "raw", "wav", "ana"),
            _tool("blur.blur"),  # curated: applyEffect wraps pvoc itself
        ]
        pipeline = {
            "name": "wrap", "steps": [
                {"uid": "a", "toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True},
                {"uid": "b", "toolId": "blur.blur", "kind": "effect", "values": {}, "enabled": True},
            ],
        }
        r = self.run_cases([{"id": "v", "op": "validate", "pipeline": pipeline, "tools": tools}])
        self.assertFalse(r["v"]["ok"])
        self.assertIn("insert pvoc synth", r["v"]["errors"][0]["message"])

    def test_two_input_step_requires_input2(self):
        tools = [_tool("morph.bridge", inputs2=True)]
        pipeline = {"name": "m", "steps": [
            {"uid": "a", "toolId": "morph.bridge", "kind": "effect", "values": {}, "enabled": True}]}
        r = self.run_cases([
            {"id": "no", "op": "validate", "pipeline": pipeline, "tools": tools},
            {"id": "yes", "op": "validate", "pipeline": pipeline, "tools": tools,
             "opts": {"hasInput2": True}},
        ])
        self.assertFalse(r["no"]["ok"])
        self.assertIn("second input", r["no"]["errors"][0]["message"])
        self.assertTrue(r["yes"]["ok"])

    def test_bypassed_step_is_skipped(self):
        tools = [_tool("modify.speed"), _tool("envel.dovetail")]
        pipeline = {"name": "b", "steps": [
            {"uid": "a", "toolId": "modify.speed", "kind": "effect", "values": {}, "enabled": False},
            {"uid": "b", "toolId": "envel.dovetail", "kind": "effect", "values": {}, "enabled": True},
        ]}
        r = self.run_cases([{"id": "v", "op": "validate", "pipeline": pipeline, "tools": tools}])
        self.assertTrue(r["v"]["ok"])

    def test_info_tool_refused_in_chain(self):
        tools = [_tool("sndinfo", "info", "wav", None)]
        pipeline = {"name": "i", "steps": [
            {"uid": "a", "toolId": "sndinfo", "kind": "info", "values": {}, "enabled": True}]}
        r = self.run_cases([{"id": "v", "op": "validate", "pipeline": pipeline, "tools": tools}])
        self.assertFalse(r["v"]["ok"])

    def test_roundtrip_and_fresh_session(self):
        tools = [_tool("pvoc.anal", "raw", "wav", "ana"), _tool("raw.blur.blur", "raw", "ana", "ana")]
        pipeline = {"name": "kept", "steps": [
            {"uid": "a", "toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True},
            {"uid": "b", "toolId": "raw.blur.blur", "kind": "raw", "values": {"windows": 30}, "enabled": False},
        ]}
        r = self.run_cases([
            {"id": "rt", "op": "roundtrip", "json": json.dumps({
                "schema": "mtapi-cdp-pipeline/1", "name": "kept",
                "inputPath": "/x.wav", "input2Path": "",
                "steps": [
                    {"toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True},
                    {"toolId": "raw.blur.blur", "kind": "raw", "values": {"windows": 30}, "enabled": False},
                ]})},
        ])
        self.assertEqual(r["rt"]["name"], "kept")
        self.assertEqual(r["rt"]["steps"], 2)
        self.assertEqual(r["rt"]["enabled"], [True, False])
        # the re-serialized form is itself loadable (fork-on-edit never degrades)
        r2 = self.run_cases([{"id": "rt2", "op": "roundtrip", "json": r["rt"]["again"]}])
        self.assertEqual(r2["rt2"]["steps"], 2)

    def test_roundtrip_rejects_wrong_schema_and_bad_steps(self):
        r = self.run_cases([
            {"id": "schema", "op": "roundtrip_fail", "json": json.dumps({"schema": "other/1", "steps": []})},
            {"id": "nostep", "op": "roundtrip_fail", "json": json.dumps({"schema": "mtapi-cdp-pipeline/1", "steps": [{}]})},
            {"id": "badjson", "op": "roundtrip_fail", "json": "{nope"},
        ])
        self.assertIn("schema", r["schema"])
        self.assertIn("toolId", r["nostep"])
        self.assertIn("JSON", r["badjson"])

    def test_slim_step_is_cloneable_and_resolves_types(self):
        tools = [_tool("pvoc.anal", "raw", "wav", "ana")]
        step = {"uid": "a", "toolId": "pvoc.anal", "kind": "raw", "values": {}, "enabled": True}
        r = self.run_cases([{"id": "s", "op": "slim", "step": step, "tools": tools}])
        self.assertEqual(r["s"]["inExt"], "wav")
        self.assertEqual(r["s"]["outExt"], "ana")
        # no functions in the slim form (structured-clone safe)
        self.assertTrue(all(v is None or isinstance(v, (str, int, float, bool, dict, list))
                            for v in r["s"].values()))

    def test_newstep_seeds_defaults_from_catalog(self):
        r = self.run_cases([
            {"id": "ns", "op": "newstep", "toolId": "raw.blur.blur",
             "tools": [_tool("raw.blur.blur", "raw", "ana", "ana")]},
        ])
        self.assertEqual(r["ns"]["toolId"], "raw.blur.blur")
        self.assertEqual(r["ns"]["values"], {})

    def test_man_usage_extraction(self):
        roff = """.SH DESCRIPTION
Run CDP's \\fBmorph\\fR program.
.PP
CDP\\(aqs own usage text:
.PP
.nf
USAGE: morph NAME (mode) infile infile2 outfile parameters:

where NAME can be any one of
.fi
.SS morph.morph"""
        r = self.run_cases([{"id": "m", "op": "man", "roff": roff}])
        self.assertIn("USAGE: morph NAME (mode) infile infile2 outfile", r["m"])
        self.assertNotIn(".fi", r["m"])

    def test_argv_preview_resolves_tokens(self):
        tool = {"id": "raw.blur.blur", "kind": "raw", "program": "blur",
                "argv": ["blur", "$IN", "$OUT", {"p": "windows"}], "inExt": "ana", "outExt": "ana"}
        r = self.run_cases([
            {"id": "a", "op": "argv", "tool": tool, "values": {"windows": 30}},
        ])
        self.assertEqual(r["a"], ["blur", "blur", "in.ana", "out.ana", "30"])
