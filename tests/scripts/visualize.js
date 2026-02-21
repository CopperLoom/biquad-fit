#!/usr/bin/env node
/**
 * visualize.js
 *
 * Generates a side-by-side comparison HTML of AutoEQ vs biquad-fit results.
 *
 * Usage:
 *   node tests/scripts/visualize.js [iem] [target] [constraint]
 *
 * Defaults: blessing3 harman_ie_2019 qudelix_10
 *
 * Examples:
 *   node tests/scripts/visualize.js
 *   node tests/scripts/visualize.js origin_s diffuse_field qudelix_10
 *   node tests/scripts/visualize.js hexa flat standard
 *
 * Outputs: tests/scripts/output/comparison.html (opens in default browser)
 */

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { optimize }      from '../../src/optimize.js';
import { applyFilters }  from '../../src/applyFilters.js';
import { interpolate }   from '../../src/interpolate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES  = join(__dirname, '../fixtures');

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: node visualize.js [iem] [target] [constraint]

Defaults: blessing3 harman_ie_2019 qudelix_10

IEMs:        blessing3, hexa, andromeda, zero2, origin_s
Targets:     harman_ie_2019, diffuse_field, flat, v_shaped, bass_heavy, bright
Constraints: standard (5), restricted (3), qudelix_10 (10)`);
  process.exit(0);
}

const iemName        = args[0] || 'blessing3';
const targetName     = args[1] || 'harman_ie_2019';
const constraintName = args[2] || 'qudelix_10';

// ── Constraint sets (matching integration tests / generate_golden.py) ────────

const CONSTRAINT_SETS = {
  standard: {
    filterSpecs: [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ],
    freqRange: [20, 10000],
    gainRange: [-12, 12],
  },
  restricted: {
    maxFilters: 3,
    gainRange:  [-6, 6],
    qRange:     [1.0, 5.0],
    freqRange:  [20, 10000],
  },
  qudelix_10: {
    filterSpecs: [
      { type: 'LSQ', gainRange: [-12, 12] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'PK',  gainRange: [-12, 12], qRange: [0.5, 10] },
      { type: 'HSQ', gainRange: [-12, 12] },
    ],
    freqRange: [20, 10000],
    gainRange: [-12, 12],
  },
};

const constraints = CONSTRAINT_SETS[constraintName];
if (!constraints) {
  console.error(`Unknown constraint set: ${constraintName}`);
  console.error(`Available: ${Object.keys(CONSTRAINT_SETS).join(', ')}`);
  process.exit(1);
}

// ── Load data ────────────────────────────────────────────────────────────────

const goldenFile = `${iemName}_${targetName}_${constraintName}.json`;

const fr      = JSON.parse(readFileSync(join(FIXTURES, `fr/${iemName}.json`), 'utf8'));
const target  = JSON.parse(readFileSync(join(FIXTURES, `targets/${targetName}.json`), 'utf8'));
const golden  = JSON.parse(readFileSync(join(FIXTURES, `golden/${goldenFile}`), 'utf8'));

console.log(`IEM:        ${iemName}`);
console.log(`Target:     ${targetName}`);
console.log(`Constraint: ${constraintName}`);

// ── Center FR at 1kHz ────────────────────────────────────────────────────────

function centerAt1k(points) {
  const interp = interpolate(points);
  const ref    = interp.find(p => p.freq >= 1000);
  const offset = ref ? ref.db : 0;
  return points.map(p => ({ ...p, db: p.db - offset }));
}

const frCentered = centerAt1k(fr);

// ── Run biquad-fit optimizer ─────────────────────────────────────────────────

const bfResult = optimize(frCentered, target, constraints);

// ── Compute corrected curves ─────────────────────────────────────────────────

const frInterp  = interpolate(frCentered);
const tgtInterp = interpolate(target);

// Golden file filters use {freq, gain, q} — convert to {fc, gain, Q}
const goldenFilters = golden.filters.map(f => ({
  type: f.type, fc: f.freq, gain: f.gain, Q: f.q,
}));

const aeCorrected = applyFilters(frInterp, goldenFilters, 0);
const bfCorrected = applyFilters(frInterp, bfResult.filters, 0);

// ── Compute RMSE ─────────────────────────────────────────────────────────────

function computeRmse(corrected, tgt) {
  return Math.sqrt(
    corrected.reduce((s, pt, i) => s + (pt.db - tgt[i].db) ** 2, 0) / corrected.length
  );
}

const aeRmse = computeRmse(aeCorrected, tgtInterp);
const bfRmse = computeRmse(bfCorrected, tgtInterp);

console.log(`AutoEQ RMSE:     ${aeRmse.toFixed(3)} dB (golden: ${golden.rmse.toFixed(3)})`);
console.log(`biquad-fit RMSE: ${bfRmse.toFixed(3)} dB`);

// ── Prepare data for HTML ────────────────────────────────────────────────────

// Downsample to ~500 points for reasonable HTML size
function downsample(points, maxPts = 500) {
  if (points.length <= maxPts) return points;
  const step = Math.ceil(points.length / maxPts);
  return points.filter((_, i) => i % step === 0);
}

const chartData = {
  measured:    downsample(frInterp),
  target:      downsample(tgtInterp),
  aeCorrected: downsample(aeCorrected),
  bfCorrected: downsample(bfCorrected),
  aeRmse,
  bfRmse,
  goldenRmse:  golden.rmse,
  aeFilters:   golden.filters,
  bfFilters:   bfResult.filters.map(f => ({ type: f.type, freq: f.fc, gain: f.gain, q: f.Q })),
  aePregain:   golden.pregain,
  bfPregain:   bfResult.pregain,
};

// ── Generate HTML ────────────────────────────────────────────────────────────

// Pretty names for display
const iemNames = {
  blessing3: 'Moondrop Blessing 3', hexa: 'Truthear Hexa S2',
  andromeda: 'Campfire Andromeda 2020', zero2: '7Hz × Crinacle Zero 2',
  origin_s: 'Tanchjim Origin S',
};
const targetNames = {
  harman_ie_2019: 'Harman IE 2019v2', diffuse_field: 'Diffuse Field 5128',
  flat: 'Flat', v_shaped: 'V-Shaped', bass_heavy: 'Bass Heavy', bright: 'Bright',
};
const constraintLabels = {
  standard: '5 bands (standard)', restricted: '3 bands (restricted)',
  qudelix_10: '10 bands (Qudelix)',
};

const displayIem        = iemNames[iemName] || iemName;
const displayTarget     = targetNames[targetName] || targetName;
const displayConstraint = constraintLabels[constraintName] || constraintName;

// Filter table builder — all data comes from our own golden/optimizer output.
function buildFilterTableHtml(filters, pregain) {
  const sorted = [...filters].sort((a, b) => a.freq - b.freq);
  const rows = sorted.map(f => {
    const sign = f.gain >= 0 ? '+' : '';
    return `<tr><td>${f.type}</td><td>${Math.round(f.freq)} Hz</td>`
         + `<td>${sign}${f.gain.toFixed(2)} dB</td><td>${f.q.toFixed(2)}</td></tr>`;
  }).join('');
  const preStr = (pregain >= 0 ? '+' : '') + pregain.toFixed(2) + ' dB';
  return `<table><tr><th>Type</th><th>Freq</th><th>Gain</th><th>Q</th></tr>${rows}</table>`
       + `<div style="margin-top:4px">Pregain: ${preStr}</div>`;
}

const aeFilterHtml = buildFilterTableHtml(chartData.aeFilters, chartData.aePregain);
const bfFilterHtml = buildFilterTableHtml(chartData.bfFilters, chartData.bfPregain);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>biquad-fit vs AutoEQ — ${displayIem} × ${displayTarget}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
         background: #1a1a2e; color: #e0e0e0; padding: 20px; }
  h1 { text-align: center; font-size: 18px; margin-bottom: 4px; color: #ccc; }
  .subtitle { text-align: center; font-size: 13px; color: #888; margin-bottom: 16px; }
  .panels { display: flex; gap: 16px; justify-content: center; flex-wrap: wrap; }
  .panel { background: #16213e; border-radius: 8px; padding: 16px; flex: 1; min-width: 500px; max-width: 700px; }
  .panel h2 { font-size: 14px; margin-bottom: 8px; color: #aaa; }
  canvas { width: 100%; background: #0f0f23; border-radius: 4px; }
  .legend { display: flex; gap: 16px; justify-content: center; margin-top: 8px; font-size: 12px; }
  .legend span { display: flex; align-items: center; gap: 4px; }
  .legend .swatch { width: 20px; height: 3px; border-radius: 2px; }
  .filters { margin-top: 12px; font-size: 11px; color: #888; }
  .filters table { width: 100%; border-collapse: collapse; }
  .filters td, .filters th { padding: 2px 6px; text-align: right; }
  .filters th { color: #aaa; border-bottom: 1px solid #333; text-align: right; }
  .filters td:first-child, .filters th:first-child { text-align: left; }
  .rmse { font-size: 13px; color: #7fdbca; margin-top: 6px; }
</style>
</head>
<body>
<h1>biquad-fit vs AutoEQ</h1>
<div class="subtitle">${displayIem} &times; ${displayTarget} &mdash; ${displayConstraint}</div>

<div class="panels">
  <div class="panel">
    <h2>AutoEQ (golden reference)</h2>
    <canvas id="ae" width="660" height="360"></canvas>
    <div class="legend">
      <span><span class="swatch" style="background:#888"></span> Measured</span>
      <span><span class="swatch" style="background:#5b9bd5;opacity:0.8"></span> Target</span>
      <span><span class="swatch" style="background:#7fdbca"></span> Corrected</span>
    </div>
    <div class="rmse" id="ae-rmse"></div>
    <div class="filters">${aeFilterHtml}</div>
  </div>
  <div class="panel">
    <h2>biquad-fit</h2>
    <canvas id="bf" width="660" height="360"></canvas>
    <div class="legend">
      <span><span class="swatch" style="background:#888"></span> Measured</span>
      <span><span class="swatch" style="background:#5b9bd5;opacity:0.8"></span> Target</span>
      <span><span class="swatch" style="background:#c3e88d"></span> Corrected</span>
    </div>
    <div class="rmse" id="bf-rmse"></div>
    <div class="filters">${bfFilterHtml}</div>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(chartData)};

function drawChart(canvasId, measured, target, corrected, correctedColor) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width * dpr;
  const h = canvas.height * dpr;
  canvas.width = w;
  canvas.height = h;
  ctx.scale(dpr, dpr);
  const cw = w / dpr;
  const ch = h / dpr;

  const pad = { top: 20, right: 20, bottom: 36, left: 46 };
  const pw = cw - pad.left - pad.right;
  const ph = ch - pad.top - pad.bottom;

  // Frequency range: 20-20000 Hz (log scale)
  const fMin = 20, fMax = 20000;
  const logMin = Math.log10(fMin), logMax = Math.log10(fMax);

  // dB range: auto from data with padding
  const allDb = [...measured, ...target, ...corrected].map(p => p.db);
  const dbMin = Math.floor(Math.min(...allDb) / 5) * 5 - 5;
  const dbMax = Math.ceil(Math.max(...allDb) / 5) * 5 + 5;

  function xOf(freq) { return pad.left + (Math.log10(freq) - logMin) / (logMax - logMin) * pw; }
  function yOf(db) { return pad.top + (1 - (db - dbMin) / (dbMax - dbMin)) * ph; }

  // Grid
  ctx.strokeStyle = '#2a2a4a';
  ctx.lineWidth = 0.5;
  const gridFreqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const f of gridFreqs) {
    const x = xOf(f);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ph); ctx.stroke();
  }
  for (let db = dbMin; db <= dbMax; db += 5) {
    const y = yOf(db);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
  }

  // Axis labels
  ctx.fillStyle = '#666';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  for (const f of gridFreqs) {
    const label = f >= 1000 ? (f / 1000) + 'k' : String(f);
    ctx.fillText(label, xOf(f), pad.top + ph + 14);
  }
  ctx.textAlign = 'right';
  for (let db = dbMin; db <= dbMax; db += 5) {
    ctx.fillText(db + ' dB', pad.left - 4, yOf(db) + 3);
  }

  // Draw curve
  function drawCurve(points, color, dash, lineWidth) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth || 1.5;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    let started = false;
    for (const p of points) {
      if (p.freq < fMin || p.freq > fMax) continue;
      const x = xOf(p.freq), y = yOf(p.db);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawCurve(measured,  '#888888', [], 1);
  drawCurve(target,    '#5b9bd5', [6, 3], 1.5);
  drawCurve(corrected, correctedColor, [], 2);
}

drawChart('ae', DATA.measured, DATA.target, DATA.aeCorrected, '#7fdbca');
drawChart('bf', DATA.measured, DATA.target, DATA.bfCorrected, '#c3e88d');

document.getElementById('ae-rmse').textContent = 'RMSE: ' + DATA.aeRmse.toFixed(3) + ' dB (golden: ' + DATA.goldenRmse.toFixed(3) + ')';
document.getElementById('bf-rmse').textContent = 'RMSE: ' + DATA.bfRmse.toFixed(3) + ' dB';
</script>
</body>
</html>`;

// ── Write and open ───────────────────────────────────────────────────────────

const outPath = join(__dirname, 'output/comparison.html');
writeFileSync(outPath, html);
console.log(`\nWritten: ${outPath}`);

try {
  execFileSync('open', [outPath]);
} catch {
  console.log('Could not auto-open — open the file manually in a browser.');
}
