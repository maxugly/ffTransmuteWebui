// Run with node; no frontend framework or dependency installation required.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../app/static/js/ui/reference-cell-shading.js', import.meta.url), 'utf8');
const {numericCell, cellState, createCellShading} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

assert.equal(numericCell('450ms').number, .45);
assert.equal(numericCell('1.2B parameters').number, 1.2e9);
assert.equal(numericCell('6–8GB').number, 7e9);
assert.equal(numericCell('1024 MB').number, 1.024e9);
assert.equal(numericCell('-5–-1').number, -3);
assert.equal(numericCell('39M–1.55B').number, (39e6+1.55e9)/2);
for (const prose of ['gpt-4o', '2026-10-10', 'GPU 6–8GB', '60% preferred in benchmark']) {
  assert.equal(numericCell(prose), null);
}
assert.equal(cellState('Yes, depending on the backend'), 'conditional');
assert.equal(cellState('Yes/No'), 'partial');
assert.equal(cellState('—'), 'neutral');

const shade = createCellShading(['Model', 'Memory', 'State', 'License', 'Latency'], [
  ['a', '512 MB', 'Yes', 'MIT', '450ms'], ['b', '1 GB', 'No', 'MIT', '1 s'],
  ['c', '2 GB', 'Partial', 'Non-commercial', '100ms'], ['d', '-', 'Conditional', 'Apache-2.0', '2 s'],
]);
assert(shade('512 MB', 1).hue > shade('2 GB', 1).hue);
assert(shade('100ms', 4).hue > shade('2 s', 4).hue);
assert.equal(shade('Non-commercial', 3).kind, 'warning');
assert.equal(shade('MIT', 3).kind, 'repeat');
assert.equal(shade('—', 1).kind, 'neutral');
assert.equal(shade('Partial', 2).kind, 'partial');
assert.equal(shade('Conditional', 2).kind, 'conditional');
assert.equal(shade('Yes', 2).kind, 'yes');
assert.equal(shade('No', 2).kind, 'no');
assert.equal(createCellShading(['Model', 'Limits'], [['a', 'Requires a supplied transcript']])('Requires a supplied transcript', 1).kind, 'warning');
console.log('PASS comparable units/ranges, prose rejection, state colors, repeated values and warning precedence');
