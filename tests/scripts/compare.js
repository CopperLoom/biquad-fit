#!/usr/bin/env node
/**
 * compare.js
 *
 * Compare AutoEQ vs biquad-fit on an arbitrary FR + target curve.
 *
 * Usage:
 *   node tests/scripts/compare.js <fr_file> <target_file> [bands]
 *   node tests/scripts/compare.js <fr_file> <target_file> --bands 10 --gain 12 --q-min 0.5 --q-max 10
 *
 * File formats accepted: JSON [{freq, db}] or CSV with frequency/raw columns.
 * Bands default to 5.
 *
 * TODO (v2): when the DE optimizer gains LSQ/HSQ support, update buildAutoeqConfig()
 * to use mixed filter types (1 LSQ + (N-2) PK + 1 HSQ for N >= 4) instead of all-PK.
 * Also un-skip the 'mixed filter types (v2)' test in tests/unit/optimize.test.js.
 */

import { readFileSync } from 'fs';
import { spawnSync }    from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { optimize }      from '../src/optimize.js';
import { applyFilters }  from '../src/applyFilters.js';
import { interpolate }   from '../src/interpolate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));

const frPath     = pos[0]   || flags['fr'];
const targetPath = pos[1]   || flags['target'];
const bands      = parseInt(flags['bands']   || pos[2] || '5');
const gainMax    = parseFloat(flags['gain']    || '12');
const qMin       = parseFloat(flags['q-min']   || '0.5');
const qMax       = parseFloat(flags['q-max']   || '10');
const freqMin    = parseFloat(flags['freq-min'] || '20');
const freqMax    = parseFloat(flags['freq-max'] || '10000');

if (!frPath || !targetPath) {
  console.error(
    'Usage: compare.js <fr_file> <target_file> [bands]\n' +
    '       --bands N  --gain G  --q-min Q  --q-max Q  --freq-min F  --freq-max F'
  );
  process.exit(1);
}

// ── File loading ──────────────────────────────────────────────────────────────

function loadFile(path) {
  const raw = readFileSync(path, 'utf8').trim();
  if (path.endsWith('.json')) return JSON.parse(raw);

  // CSV: detect freq column (frequency/freq) and db column (raw/db)
  const lines  = raw.split('\n');
  const header = lines[0].toLowerCase().split(',').map(s => s.trim());
  const fi     = header.findIndex(h => h.startsWith('freq'));
  const di     = header.findIndex(h => h === 'raw' || h === 'db');
  if (fi < 0 || di < 0) throw new Error(`Cannot parse CSV headers in ${path}: ${lines[0]}`);

  return lines.slice(1)
    .map(l => { const p = l.split(','); return { freq: parseFloat(p[fi]), db: parseFloat(p[di]) }; })
    .filter(p => isFinite(p.freq) && isFinite(p.db));
}

const fr     = loadFile(frPath);
const target = loadFile(targetPath);

// ── AutoEQ config builder ─────────────────────────────────────────────────────
// TODO (v2): replace all-PK with mixed types once biquad-fit supports LSQ/HSQ.
// For N >= 4: [LOW_SHELF, ...PK×(N-2)..., HIGH_SHELF]

function buildAutoeqConfig(n, gainMax, qMin, qMax, freqMin, freqMax) {
  return {
    filters: Array.from({ length: n }, () => ({
      type: 'PEAKING',
      min_gain: -gainMax, max_gain: gainMax,
      min_q: qMin,        max_q: qMax,
      min_fc: freqMin,    max_fc: freqMax,
    })),
  };
}

// ── Center FR ─────────────────────────────────────────────────────────────────
// AutoEQ normalizes the measured FR to 0 dB at 1kHz before compensating.
// biquad-fit's compensate() is a pure subtraction — no centering.
// We pre-center here so both engines operate on comparable scales.
// NOTE: integration tests will need the same treatment when calling optimize()
// on raw fixture data (absolute SPL measurements, ~85–105 dB).

function centerAt1k(points) {
  const interp = interpolate(points);
  const ref    = interp.find(p => p.freq >= 1000);   // first point at or above 1kHz
  const offset = ref ? ref.db : 0;
  return points.map(p => ({ ...p, db: p.db - offset }));
}

const frCentered = centerAt1k(fr);

// ── Run biquad-fit ────────────────────────────────────────────────────────────

const constraints = { maxFilters: bands, gainRange: [-gainMax, gainMax], qRange: [qMin, qMax], freqRange: [freqMin, freqMax] };
const jsResult    = optimize(frCentered, target, constraints);

// RMSE without pregain (shape comparison only, matches generate_golden.py convention)
const frInterp  = interpolate(frCentered);
const tgtInterp = interpolate(target);
const corrected = applyFilters(frInterp, jsResult.filters, 0);
const jsRmse    = Math.sqrt(
  corrected.reduce((s, pt, i) => s + (pt.db - tgtInterp[i].db) ** 2, 0) / corrected.length
);

// ── Run AutoEQ ────────────────────────────────────────────────────────────────

const aeInput  = JSON.stringify({ fr, target, config: buildAutoeqConfig(bands, gainMax, qMin, qMax, freqMin, freqMax) });
const pyResult = spawnSync('python3', [join(__dirname, 'autoeq_run.py')], { input: aeInput, encoding: 'utf8' });

if (pyResult.error || pyResult.status !== 0) {
  console.error('AutoEQ failed:', pyResult.stderr || pyResult.error?.message);
  process.exit(1);
}

const aeResult = JSON.parse(pyResult.stdout);

// ── Print comparison table ────────────────────────────────────────────────────

const COL = 36;
const LINE = '─'.repeat(COL);

function fmtFilter(f) {
  const sign = f.gain >= 0 ? '+' : '';
  return `${f.type.padEnd(3)}  ${String(Math.round(f.freq)).padStart(5)} Hz  ${(sign + f.gain.toFixed(2) + ' dB').padEnd(11)}  Q=${f.q.toFixed(2)}`;
}

// Normalize biquad-fit filter to same shape as AutoEQ output
const jsFilters = jsResult.filters.map(f => ({ type: f.type, freq: f.fc, gain: f.gain, q: f.Q }));

const aeSorted = [...aeResult.filters].sort((a, b) => a.freq - b.freq);
const jsSorted = [...jsFilters].sort((a, b) => a.freq - b.freq);

console.log(`\nFR:     ${frPath}  (${fr.length} pts)`);
console.log(`Target: ${targetPath}  (${target.length} pts)`);
console.log(`Bands:  ${bands}  |  gain ±${gainMax} dB  |  Q ${qMin}–${qMax}  |  freq ${freqMin}–${freqMax} Hz\n`);

console.log(`${'AutoEQ (all-PK, v2 will use shelves)'.padEnd(COL)}  biquad-fit (all-PK)`);
console.log(`${LINE}  ${LINE}`);

const rows = Math.max(aeSorted.length, jsSorted.length);
for (let i = 0; i < rows; i++) {
  const left  = aeSorted[i] ? fmtFilter(aeSorted[i]) : '';
  const right = jsSorted[i] ? fmtFilter(jsSorted[i]) : '';
  console.log(`${left.padEnd(COL)}  ${right}`);
}

console.log(`${LINE}  ${LINE}`);

const aePreStr = (aeResult.pregain >= 0 ? '+' : '') + aeResult.pregain.toFixed(2) + ' dB';
const jsPreStr = (jsResult.pregain >= 0 ? '+' : '') + jsResult.pregain.toFixed(2) + ' dB';
console.log(`${'Pregain'.padEnd(16)}${aePreStr.padEnd(COL - 16)}  Pregain         ${jsPreStr}`);

const aeRmseStr = aeResult.rmse.toFixed(3) + ' dB';
const jsRmseStr = jsRmse.toFixed(3) + ' dB';
console.log(`${'RMSE'.padEnd(16)}${aeRmseStr.padEnd(COL - 16)}  RMSE            ${jsRmseStr}`);
console.log();
