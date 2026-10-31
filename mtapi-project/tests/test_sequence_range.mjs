// Run with node; no frontend framework or dependency installation required.
//   node mtapi-project/tests/test_sequence_range.mjs
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../app/static/js/pool/sequence-range.js', import.meta.url), 'utf8');
const {resolveRange, sliceRange, parseRangeBound, rangeClipCount, rangeIncludes, rangeLabel, rangeHint} =
  await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

// ── bound parsing ───────────────────────────────────────────────────────────
assert.deepEqual(parseRangeBound(null), {value: null, error: null});
assert.deepEqual(parseRangeBound(''), {value: null, error: null});
assert.deepEqual(parseRangeBound('   '), {value: null, error: null});
assert.deepEqual(parseRangeBound('34'), {value: 34, error: null});
assert.deepEqual(parseRangeBound(34), {value: 34, error: null});
assert.deepEqual(parseRangeBound('0'), {value: null, error: 'must be 1 or more'});
assert.deepEqual(parseRangeBound('abc'), {value: null, error: 'must be a whole number'});
assert.deepEqual(parseRangeBound('3.5'), {value: null, error: 'must be a whole number'});

// ── no range = whole sequence ───────────────────────────────────────────────
let r = resolveRange({from: null, to: null}, 60);
assert.equal(r.active, false);
assert.equal(r.error, null);
assert.equal(r.count, 60);
assert.equal(r.from, null);
assert.equal(r.to, null);
assert.equal(rangeLabel(r), '');
assert.equal(rangeClipCount(r), 60);
assert.equal(resolveRange(null, 0).count, 0);

// ── the headline case: clip 34 → 56 ─────────────────────────────────────────
r = resolveRange({from: '34', to: '56'}, 60);
assert.equal(r.active, true);
assert.equal(r.error, null);
assert.equal(r.from, 34);
assert.equal(r.to, 56);
assert.equal(r.count, 23);
assert.equal(rangeClipCount(r), 23);
assert.equal(rangeLabel(r), '34–56');
assert.equal(rangeHint(r), 'Clips 34–56 of 60 · 23 clips');
assert.equal(r.clipped, false);

// ── open bounds ─────────────────────────────────────────────────────────────
r = resolveRange({from: '34', to: null}, 60);
assert.equal(r.from, 34);
assert.equal(r.to, 60);
assert.equal(r.count, 27);
r = resolveRange({from: null, to: '56'}, 60);
assert.equal(r.from, 1);
assert.equal(r.to, 56);
assert.equal(r.count, 56);

// ── clamping and errors ─────────────────────────────────────────────────────
r = resolveRange({from: '34', to: '999'}, 60);
assert.equal(r.error, null);
assert.equal(r.to, 60);
assert.equal(r.count, 27);
assert.equal(r.clipped, true);
assert.match(r.note, /clamped/);

r = resolveRange({from: '61', to: null}, 60);
assert.match(r.error, /past the last clip/);
assert.equal(rangeClipCount(r), 0);

r = resolveRange({from: '56', to: '34'}, 60);
assert.match(r.error, /after To clip/);

r = resolveRange({from: '0', to: null}, 60);
assert.match(r.error, /From clip must be 1 or more/);

r = resolveRange({from: null, to: 'x'}, 60);
assert.match(r.error, /To clip must be a whole number/);

r = resolveRange({from: '1', to: '2'}, 0);
assert.match(r.error, /Sequence is empty/);

// ── slicing ─────────────────────────────────────────────────────────────────
const clips = Array.from({length: 60}, (_, i) => `clip${i + 1}.mp4`);
let s = sliceRange({from: '34', to: '56'}, clips);
assert.equal(s.entries.length, 23);
assert.equal(s.entries[0], 'clip34.mp4');
assert.equal(s.entries[22], 'clip56.mp4');

s = sliceRange({from: null, to: null}, clips);
assert.equal(s.entries.length, 60);

s = sliceRange({from: '61', to: null}, clips);
assert.equal(s.entries.length, 0);
assert.match(s.resolved.error, /past the last clip/);

// ── membership ──────────────────────────────────────────────────────────────
const rr = resolveRange({from: '34', to: '56'}, 60);
assert.equal(rangeIncludes(rr, 1), false);
assert.equal(rangeIncludes(rr, 33), false);
assert.equal(rangeIncludes(rr, 34), true);
assert.equal(rangeIncludes(rr, 56), true);
assert.equal(rangeIncludes(rr, 57), false);
assert.equal(rangeIncludes(rr, 60), false);
const whole = resolveRange({from: null, to: null}, 60);
assert.equal(rangeIncludes(whole, 1), true);
assert.equal(rangeIncludes(whole, 60), true);

console.log('PASS range bounds, clip 34–56 window, clamping, errors, slicing and membership');
