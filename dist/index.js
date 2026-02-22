// src/biquadResponse.js
var DEFAULT_FS = 44100;
function biquadCoeffs(type, fc, gain, Q, fs) {
  const A = Math.pow(10, gain / 40);
  const w0 = 2 * Math.PI * fc / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === "PK") {
    a0 = 1 + alpha / A;
    b0 = (1 + alpha * A) / a0;
    b1 = -2 * cosW0 / a0;
    b2 = (1 - alpha * A) / a0;
    a1 = -2 * cosW0 / a0;
    a2 = (1 - alpha / A) / a0;
  } else if (type === "LSQ") {
    const sqrtA = Math.sqrt(A);
    a0 = A + 1 + (A - 1) * cosW0 + 2 * sqrtA * alpha;
    b0 = A * (A + 1 - (A - 1) * cosW0 + 2 * sqrtA * alpha) / a0;
    b1 = 2 * A * (A - 1 - (A + 1) * cosW0) / a0;
    b2 = A * (A + 1 - (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0;
    a1 = -2 * (A - 1 + (A + 1) * cosW0) / a0;
    a2 = (A + 1 + (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0;
  } else if (type === "HSQ") {
    const sqrtA = Math.sqrt(A);
    a0 = A + 1 - (A - 1) * cosW0 + 2 * sqrtA * alpha;
    b0 = A * (A + 1 + (A - 1) * cosW0 + 2 * sqrtA * alpha) / a0;
    b1 = -2 * A * (A - 1 + (A + 1) * cosW0) / a0;
    b2 = A * (A + 1 + (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0;
    a1 = 2 * (A - 1 - (A + 1) * cosW0) / a0;
    a2 = (A + 1 - (A - 1) * cosW0 - 2 * sqrtA * alpha) / a0;
  } else {
    throw new Error(`Unknown filter type: ${type}. Expected 'PK', 'LSQ', or 'HSQ'.`);
  }
  return { b0, b1, b2, a1, a2 };
}
function evalMagnitude(c, f, fs) {
  const { b0, b1, b2, a1, a2 } = c;
  const w = 2 * Math.PI * f / fs;
  const phi = 4 * Math.sin(w / 2) ** 2;
  const num = (b0 + b1 + b2) ** 2 + (b0 * b2 * phi - b1 * (b0 + b2) - 4 * b0 * b2) * phi;
  const den = (1 + a1 + a2) ** 2 + (a2 * phi - a1 * (1 + a2) - 4 * a2) * phi;
  return 10 * Math.log10(num / den);
}
function biquadResponse(type, fc, gain, Q, frequencies, fs = DEFAULT_FS) {
  const c = biquadCoeffs(type, fc, gain, Q, fs);
  return frequencies.map((f) => evalMagnitude(c, f, fs));
}

// src/interpolate.js
var DEFAULTS = {
  step: 1.01,
  fMin: 20,
  fMax: 2e4
};
function buildGrid(fMin, fMax, step) {
  const freqs = [];
  let f = fMin;
  while (f <= fMax + 1e-9) {
    freqs.push(f);
    f *= step;
  }
  return freqs;
}
function interpolate(fr, options = {}) {
  const { step, fMin, fMax } = { ...DEFAULTS, ...options };
  const logFreqs = fr.map((pt) => Math.log(pt.freq));
  const dbs = fr.map((pt) => pt.db);
  const grid = buildGrid(fMin, fMax, step);
  return grid.map((freq) => {
    const logF = Math.log(freq);
    if (logF <= logFreqs[0]) {
      return { freq, db: dbs[0] };
    }
    if (logF >= logFreqs[logFreqs.length - 1]) {
      return { freq, db: dbs[dbs.length - 1] };
    }
    let lo = 0;
    let hi = logFreqs.length - 1;
    while (hi - lo > 1) {
      const mid = lo + hi >> 1;
      if (logFreqs[mid] <= logF) lo = mid;
      else hi = mid;
    }
    const t = (logF - logFreqs[lo]) / (logFreqs[hi] - logFreqs[lo]);
    const db = dbs[lo] + t * (dbs[hi] - dbs[lo]);
    return { freq, db };
  });
}

// src/compensate.js
function compensate(measured, target, options = {}) {
  const m = interpolate(measured, options);
  const t = interpolate(target, options);
  return m.map((pt, i) => ({
    freq: pt.freq,
    db: pt.db - t[i].db
  }));
}

// src/smooth.js
var DEFAULTS2 = {
  windowOctaves: 1 / 3
};
function savgolCoeffs(windowSize, polyOrder) {
  const m = (windowSize - 1) / 2;
  const nCols = polyOrder + 1;
  const V = [];
  for (let i = -m; i <= m; i++) {
    const row = new Array(nCols);
    row[0] = 1;
    for (let j = 1; j < nCols; j++) row[j] = row[j - 1] * i;
    V.push(row);
  }
  const VtV = Array.from({ length: nCols }, () => new Array(nCols).fill(0));
  for (let i = 0; i < nCols; i++) {
    for (let j = 0; j < nCols; j++) {
      for (let k = 0; k < windowSize; k++) {
        VtV[i][j] += V[k][i] * V[k][j];
      }
    }
  }
  const aug = VtV.map((row, i) => {
    const ext = new Array(nCols).fill(0);
    ext[i] = 1;
    return [...row, ...ext];
  });
  for (let col = 0; col < nCols; col++) {
    let maxRow = col;
    for (let row = col + 1; row < nCols; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    const pivot = aug[col][col];
    for (let j = col; j < 2 * nCols; j++) aug[col][j] /= pivot;
    for (let row = 0; row < nCols; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = col; j < 2 * nCols; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }
  const inv = aug.map((row) => row.slice(nCols));
  const coeffs = new Array(windowSize);
  for (let k = 0; k < windowSize; k++) {
    let c = 0;
    for (let j = 0; j < nCols; j++) {
      c += inv[0][j] * V[k][j];
    }
    coeffs[k] = c;
  }
  return coeffs;
}
var coeffsCache = /* @__PURE__ */ new Map();
function getCachedCoeffs(windowSize) {
  if (!coeffsCache.has(windowSize)) {
    coeffsCache.set(windowSize, savgolCoeffs(windowSize, 2));
  }
  return coeffsCache.get(windowSize);
}
function savgolFilter(data, windowSize) {
  const n = data.length;
  if (windowSize >= n) windowSize = n % 2 === 0 ? n - 1 : n;
  if (windowSize < 3) windowSize = 3;
  const coeffs = getCachedCoeffs(windowSize);
  const m = (windowSize - 1) / 2;
  const result = new Array(n);
  for (let i = m; i < n - m; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += coeffs[j] * data[i - m + j];
    }
    result[i] = sum;
  }
  for (let i = 0; i < m; i++) {
    result[i] = fitPolyEval(data, 0, windowSize, i);
  }
  for (let i = n - m; i < n; i++) {
    result[i] = fitPolyEval(data, n - windowSize, windowSize, i - (n - windowSize));
  }
  return result;
}
function fitPolyEval(data, start, len, pos) {
  const mid = (len - 1) / 2;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0;
  let r0 = 0, r1 = 0, r2 = 0;
  for (let j = 0; j < len; j++) {
    const x2 = j - mid;
    const x22 = x2 * x2;
    s0 += 1;
    s1 += x2;
    s2 += x22;
    s3 += x2 * x22;
    s4 += x22 * x22;
    const y = data[start + j];
    r0 += y;
    r1 += x2 * y;
    r2 += x22 * y;
  }
  const A = [
    [s0, s1, s2, r0],
    [s1, s2, s3, r1],
    [s2, s3, s4, r2]
  ];
  for (let col = 0; col < 3; col++) {
    let maxRow = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row;
    }
    [A[col], A[maxRow]] = [A[maxRow], A[col]];
    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-15) continue;
    for (let j = col; j <= 3; j++) A[col][j] /= pivot;
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = A[row][col];
      for (let j = col; j <= 3; j++) A[row][j] -= f * A[col][j];
    }
  }
  const a0 = A[0][3], a1 = A[1][3], a2 = A[2][3];
  const x = pos - mid;
  return a0 + a1 * x + a2 * x * x;
}
function smoothingWindowSize(freqs, octaves) {
  const k = Math.pow(2, octaves);
  let stepSum = 0;
  for (let i = 1; i < freqs.length; i++) {
    stepSum += freqs[i] / freqs[i - 1];
  }
  const stepSize = stepSum / (freqs.length - 1);
  let n = Math.round(Math.log(k) / Math.log(stepSize));
  if (n % 2 === 0) n += 1;
  return Math.max(3, n);
}
function smooth(fr, options = {}) {
  const { windowOctaves } = { ...DEFAULTS2, ...options };
  const freqs = fr.map((pt) => pt.freq);
  const data = fr.map((pt) => pt.db);
  const windowSize = smoothingWindowSize(freqs, windowOctaves);
  const smoothed = savgolFilter(data, windowSize);
  return fr.map((pt, i) => ({
    freq: pt.freq,
    db: smoothed[i]
  }));
}

// src/equalize.js
var TREBLE_F_LOWER = 6e3;
var TREBLE_F_UPPER = 8e3;
var NORMAL_SMOOTH_OCTAVES = 1 / 12;
var TREBLE_SMOOTH_OCTAVES = 2;
var MAX_SLOPE = 18;
var MAX_GAIN = 6;
var RE_SMOOTH_OCTAVES = 1 / 5;
function twoZoneSmooth(fr, normalOct = NORMAL_SMOOTH_OCTAVES, trebleOct = TREBLE_SMOOTH_OCTAVES) {
  const normal = smooth(fr, { windowOctaves: normalOct });
  const treble = smooth(fr, { windowOctaves: trebleOct });
  const fCenter = Math.sqrt(TREBLE_F_UPPER / TREBLE_F_LOWER) * TREBLE_F_LOWER;
  const halfRange = Math.log10(TREBLE_F_UPPER) - Math.log10(fCenter);
  const logFCtr = Math.log10(fCenter);
  return fr.map((pt, i) => {
    const x = (Math.log10(pt.freq) - logFCtr) / (halfRange / 4);
    const kTreble = 1 / (1 + Math.exp(-x));
    const kNormal = 1 - kTreble;
    return { freq: pt.freq, db: normal[i].db * kNormal + treble[i].db * kTreble };
  });
}
function findPeaks(arr, minProminence = 1) {
  const maxima = [];
  let i = 1;
  while (i < arr.length - 1) {
    if (arr[i] > arr[i - 1]) {
      let j = i;
      while (j < arr.length - 1 && arr[j + 1] === arr[j]) j++;
      if (j === arr.length - 1 || arr[j + 1] < arr[j]) {
        maxima.push(i + j >> 1);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  if (maxima.length === 0) return [];
  const peaks = [];
  for (const ix of maxima) {
    const h = arr[ix];
    let leftMin = h;
    for (let j = ix - 1; j >= 0; j--) {
      if (arr[j] < leftMin) leftMin = arr[j];
      if (arr[j] > h) break;
    }
    let rightMin = h;
    for (let j = ix + 1; j < arr.length; j++) {
      if (arr[j] < rightMin) rightMin = arr[j];
      if (arr[j] > h) break;
    }
    const prominence = h - Math.max(leftMin, rightMin);
    if (prominence >= minProminence) {
      peaks.push(ix);
    }
  }
  return peaks;
}
function protectionMask(y, peakInds, dipInds) {
  const n = y.length;
  const mask = new Array(n).fill(false);
  let extDipInds, dipLevels;
  if (peakInds.length > 0 && (dipInds.length === 0 || peakInds[peakInds.length - 1] > dipInds[dipInds.length - 1])) {
    let lastDipIx = peakInds[peakInds.length - 1];
    let minVal = y[lastDipIx];
    for (let j = lastDipIx; j < n; j++) {
      if (y[j] < minVal) {
        minVal = y[j];
        lastDipIx = j;
      }
    }
    extDipInds = [...dipInds, lastDipIx];
    dipLevels = extDipInds.map((ix) => y[ix]);
  } else {
    extDipInds = [...dipInds, -1];
    dipLevels = extDipInds.map((ix) => ix >= 0 ? y[ix] : 0);
    let globalMin = Infinity;
    for (let j = 0; j < n; j++) {
      if (y[j] < globalMin) globalMin = y[j];
    }
    dipLevels[dipLevels.length - 1] = globalMin;
  }
  if (extDipInds.length < 3) return mask;
  for (let i = 1; i < extDipInds.length - 1; i++) {
    const dipIx = extDipInds[i];
    const targetLeft = dipLevels[i - 1];
    const targetRight = dipLevels[i + 1];
    let leftIx = dipIx;
    for (let j = dipIx - 1; j >= 0; j--) {
      if (y[j] >= targetLeft) {
        leftIx = j + 1;
        break;
      }
      if (j === 0) leftIx = 0;
    }
    let rightIx = dipIx;
    for (let j = dipIx + 1; j < n; j++) {
      if (y[j] >= targetRight) {
        rightIx = j - 1;
        break;
      }
      if (j === n - 1) rightIx = n - 1;
    }
    for (let j = leftIx; j <= rightIx; j++) {
      mask[j] = true;
    }
  }
  return mask;
}
function findRtlStart(y, peakInds, dipInds) {
  const n = y.length;
  if (peakInds.length > 0 && (dipInds.length === 0 || peakInds[peakInds.length - 1] > dipInds[dipInds.length - 1])) {
    const lastPeak = peakInds[peakInds.length - 1];
    let threshold;
    if (dipInds.length > 0) {
      threshold = y[dipInds[dipInds.length - 1]];
    } else {
      threshold = Math.max(y[0], y[n - 1]);
    }
    for (let j = lastPeak; j < n; j++) {
      if (y[j] <= threshold) return j;
    }
    return n - 1;
  } else {
    return dipInds[dipInds.length - 1];
  }
}
function limitedLtrSlope(freqs, y, maxSlope, startIndex, peakInds, limitFreeMask) {
  const n = y.length;
  const limited = new Array(n);
  const clipped = new Array(n).fill(false);
  const regions = [];
  for (let i = 0; i < n; i++) {
    if (i <= startIndex) {
      limited[i] = y[i];
      continue;
    }
    const octaves = Math.log2(freqs[i] / freqs[i - 1]);
    const slope = (y[i] - limited[i - 1]) / octaves;
    if (slope > maxSlope && !limitFreeMask[i]) {
      if (!clipped[i - 1]) {
        regions.push([i]);
      }
      clipped[i] = true;
      limited[i] = limited[i - 1] + maxSlope * octaves;
    } else {
      limited[i] = y[i];
      if (clipped[i - 1]) {
        const region = regions[regions.length - 1];
        region.push(i + 1);
        const regionStart = region[0];
        let hasPeak = false;
        for (let p = 0; p < peakInds.length; p++) {
          if (peakInds[p] >= regionStart && peakInds[p] < i) {
            hasPeak = true;
            break;
          }
        }
        if (!hasPeak) {
          for (let j = regionStart; j < i; j++) {
            limited[j] = y[j];
            clipped[j] = false;
          }
          regions.pop();
        }
      }
    }
  }
  if (regions.length > 0 && regions[regions.length - 1].length === 1) {
    regions[regions.length - 1].push(n - 1);
  }
  return limited;
}
function limitedRtlSlope(freqs, y, maxSlope, rtlStart, peakInds, limitFreeMask) {
  const n = y.length;
  const flippedY = [...y].reverse();
  const flippedFreqs = [...freqs].reverse();
  const flippedMask = [...limitFreeMask].reverse();
  const flippedPeaks = peakInds.map((p) => n - p - 1);
  const flippedStart = n - rtlStart - 1;
  const flippedResult = limitedLtrSlope(flippedFreqs, flippedY, maxSlope, flippedStart, flippedPeaks, flippedMask);
  return flippedResult.reverse();
}
function equalize(error) {
  const freqs = error.map((pt) => pt.freq);
  const n = freqs.length;
  const smoothed = twoZoneSmooth(error);
  const y = smoothed.map((pt) => -pt.db);
  const negY = y.map((v) => -v);
  const peakInds = findPeaks(y, 1);
  const dipInds = findPeaks(negY, 1);
  if (peakInds.length === 0 && dipInds.length === 0) {
    return y.map((v, i) => ({ freq: freqs[i], db: v }));
  }
  const limitFreeMask = protectionMask(y, peakInds, dipInds);
  const rtlStart = findRtlStart(y, peakInds, dipInds);
  const allPeakInds = [...peakInds, ...dipInds].sort((a, b) => a - b);
  const ltr = limitedLtrSlope(freqs, y, MAX_SLOPE, 0, allPeakInds, limitFreeMask);
  const rtl = limitedRtlSlope(freqs, y, MAX_SLOPE, rtlStart, allPeakInds, limitFreeMask);
  const combined = new Array(n);
  for (let i = 0; i < n; i++) {
    combined[i] = Math.min(ltr[i], rtl[i]);
  }
  for (let i = 0; i < n; i++) {
    if (combined[i] > MAX_GAIN) combined[i] = MAX_GAIN;
  }
  const toSmooth = combined.map((v, i) => ({ freq: freqs[i], db: v }));
  const reSmoothed = twoZoneSmooth(toSmooth, RE_SMOOTH_OCTAVES, RE_SMOOTH_OCTAVES);
  return reSmoothed;
}

// src/optimize.js
var DEFAULT_FS2 = 44100;
var PIPELINE_GRID = { step: 1.01, fMin: 20, fMax: 2e4 };
var OPTIMIZER_GRID = { step: 1.02, fMin: 20, fMax: 2e4 };
var SHELF_Q_RANGE = [0.4, 0.7];
var SHELF_FC_RANGE = [20, 1e4];
var IX_10K_CUTOFF = 1e4;
var LOSS_FREQ_MIN = 20;
var LOSS_FREQ_MAX = 2e4;
var MIN_STD = 2e-3;
var STD_WINDOW = 8;
var MIN_ITER = 50;
var MAX_JOINT_ITER = 150;
var PREAMP_HEADROOM = 0.2;
var LBFGS_MEMORY = 10;
var FD_H = Math.sqrt(Number.EPSILON);
function resolveSpecs(constraints, defaultFreqRange) {
  const {
    filterSpecs,
    maxFilters = 5,
    gainRange = [-12, 12],
    qRange = [0.18, 6]
    // AutoEQ defaults: 0.18248 (5-oct max bw), 6.0
  } = constraints;
  const raw = filterSpecs ? filterSpecs : Array.from({ length: maxFilters }, () => ({ type: "PK", gainRange, qRange }));
  return raw.map((s) => {
    const type = s.type || "PK";
    const isShelf = type === "LSQ" || type === "HSQ";
    return {
      type,
      gainRange: s.gainRange ?? gainRange,
      qRange: s.qRange ?? (isShelf ? SHELF_Q_RANGE : qRange),
      fcRange: s.fcRange ?? (isShelf ? SHELF_FC_RANGE : defaultFreqRange)
    };
  });
}
function sharpnessPenalty(type, fc, gain, Q, freqs, fs) {
  if (type !== "PK") return 0;
  const gainLimit = -0.09503189270199464 + 20.575128011847003 / Q;
  if (gainLimit <= 0) return 0;
  const x = gain / gainLimit - 1;
  const coeff = 1 / (1 + Math.exp(-100 * x));
  const fr = biquadResponse(type, fc, gain, Q, freqs, fs);
  return fr.reduce((s, v) => s + (v * coeff) ** 2, 0) / fr.length;
}
function findLocalPeaks(arr) {
  const peaks = [];
  let i = 1;
  while (i < arr.length - 1) {
    if (arr[i] > arr[i - 1]) {
      let j = i;
      while (j < arr.length - 1 && arr[j + 1] === arr[j]) j++;
      if (j === arr.length - 1 || arr[j + 1] < arr[j]) {
        peaks.push(i + j >> 1);
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return peaks;
}
function initPeaking(freqs, correctionDb, spec) {
  const { gainRange, qRange, fcRange } = spec;
  const minFcIdx = freqs.findIndex((f) => f >= fcRange[0]);
  let maxFcIdx = 0;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] <= fcRange[1]) {
      maxFcIdx = i;
      break;
    }
  }
  const posCorr = correctionDb.map((v) => Math.max(v, 0));
  const negCorr = correctionDb.map((v) => Math.max(-v, 0));
  let bestIx = minFcIdx, bestSize = -1;
  const evalPeaks = (peaks, arr, offset) => {
    for (const ix of peaks) {
      const absIx = ix + offset;
      if (absIx < minFcIdx || absIx > maxFcIdx) continue;
      const height = arr[ix];
      if (height <= 0) continue;
      const halfH = height / 2;
      let lo = ix, hi = ix;
      while (lo > 0 && arr[lo - 1] > halfH) lo--;
      while (hi < arr.length - 1 && arr[hi + 1] > halfH) hi++;
      let loFrac = lo;
      if (lo > 0 && arr[lo - 1] <= halfH && arr[lo] > halfH) {
        loFrac = lo - 1 + (halfH - arr[lo - 1]) / (arr[lo] - arr[lo - 1]);
      }
      let hiFrac = hi;
      if (hi < arr.length - 1 && arr[hi + 1] <= halfH && arr[hi] > halfH) {
        hiFrac = hi + (arr[hi] - halfH) / (arr[hi] - arr[hi + 1]);
      }
      const width = hiFrac - loFrac;
      const size = height * width;
      if (size > bestSize) {
        bestSize = size;
        bestIx = absIx;
      }
    }
  };
  const slicedPos = posCorr.slice(minFcIdx, maxFcIdx + 1);
  const slicedNeg = negCorr.slice(minFcIdx, maxFcIdx + 1);
  evalPeaks(findLocalPeaks(slicedPos), slicedPos, minFcIdx);
  evalPeaks(findLocalPeaks(slicedNeg), slicedNeg, minFcIdx);
  if (bestSize < 0) {
    const midIx = minFcIdx + maxFcIdx >> 1;
    return {
      type: "PK",
      fc: freqs[midIx],
      gain: 0,
      Q: Math.max(qRange[0], Math.min(qRange[1], Math.SQRT2))
    };
  }
  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]));
  const gain = Math.max(gainRange[0], Math.min(gainRange[1], correctionDb[bestIx]));
  let Q = Math.SQRT2;
  {
    const h = Math.abs(correctionDb[bestIx]) / 2;
    if (h > 0) {
      let lo = bestIx, hi = bestIx;
      while (lo > 0 && Math.abs(correctionDb[lo - 1]) > h) lo--;
      while (hi < freqs.length - 1 && Math.abs(correctionDb[hi + 1]) > h) hi++;
      let loFrac = lo, hiFrac = hi;
      if (lo > 0) {
        const a = Math.abs(correctionDb[lo - 1]), b = Math.abs(correctionDb[lo]);
        if (a <= h && b > h) loFrac = lo - 1 + (h - a) / (b - a);
      }
      if (hi < freqs.length - 1) {
        const a = Math.abs(correctionDb[hi]), b = Math.abs(correctionDb[hi + 1]);
        if (b <= h && a > h) hiFrac = hi + (a - h) / (a - b);
      }
      const fStep = Math.log2(freqs[1] / freqs[0]);
      const bwOctaves = fStep * (hiFrac - loFrac);
      if (bwOctaves > 0) {
        const bw = Math.pow(2, bwOctaves);
        if (bw > 1) Q = Math.sqrt(bw) / (bw - 1);
      }
    }
  }
  Q = Math.max(qRange[0], Math.min(qRange[1], Q));
  return { type: "PK", fc, gain, Q };
}
function initLowShelf(freqs, correctionDb, spec, fs) {
  const { gainRange, qRange, fcRange } = spec;
  const minIx = Math.max(0, freqs.findIndex((f) => f >= Math.max(40, fcRange[0])));
  let maxIx = minIx;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] < Math.min(1e4, fcRange[1])) {
      maxIx = i;
      break;
    }
  }
  let bestIx = minIx, bestAvg = 0;
  for (let i = minIx; i <= maxIx; i++) {
    let sum = 0;
    for (let j = 0; j <= i; j++) sum += correctionDb[j];
    const avg = Math.abs(sum / (i + 1));
    if (avg > bestAvg) {
      bestAvg = avg;
      bestIx = i;
    }
  }
  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]));
  const Q = Math.max(qRange[0], Math.min(qRange[1], 0.7));
  const shelfFr = biquadResponse("LSQ", fc, 1, Q, freqs, fs);
  const wtSum = shelfFr.reduce((s, v) => s + Math.abs(v), 0);
  let gain = wtSum > 0 ? correctionDb.reduce((s, v, i) => s + v * Math.abs(shelfFr[i]), 0) / wtSum : 0;
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));
  return { type: "LSQ", fc, gain, Q };
}
function initHighShelf(freqs, correctionDb, spec, fs) {
  const { gainRange, qRange, fcRange } = spec;
  const minIx = Math.max(0, freqs.findIndex((f) => f >= Math.max(40, fcRange[0])));
  let maxIx = minIx;
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] < Math.min(1e4, fcRange[1])) {
      maxIx = i;
      break;
    }
  }
  let bestIx = minIx, bestAvg = 0;
  for (let i = minIx; i <= maxIx; i++) {
    let sum = 0;
    for (let j = i; j < correctionDb.length; j++) sum += correctionDb[j];
    const avg = Math.abs(sum / (correctionDb.length - i));
    if (avg > bestAvg) {
      bestAvg = avg;
      bestIx = i;
    }
  }
  const fc = Math.max(fcRange[0], Math.min(fcRange[1], freqs[bestIx]));
  const Q = Math.max(qRange[0], Math.min(qRange[1], 0.7));
  const shelfFr = biquadResponse("HSQ", fc, 1, Q, freqs, fs);
  const wtSum = shelfFr.reduce((s, v) => s + Math.abs(v), 0);
  let gain = wtSum > 0 ? correctionDb.reduce((s, v, i) => s + v * Math.abs(shelfFr[i]), 0) / wtSum : 0;
  gain = Math.max(gainRange[0], Math.min(gainRange[1], gain));
  return { type: "HSQ", fc, gain, Q };
}
function initFilter(freqs, correctionDb, spec, fs) {
  if (spec.type === "LSQ") return initLowShelf(freqs, correctionDb, spec, fs);
  if (spec.type === "HSQ") return initHighShelf(freqs, correctionDb, spec, fs);
  return initPeaking(freqs, correctionDb, spec);
}
function totalResponse(filters, freqs, fs) {
  const sum = new Array(freqs.length).fill(0);
  for (const f of filters) {
    const r = biquadResponse(f.type, f.fc, f.gain, f.Q, freqs, fs);
    for (let i = 0; i < sum.length; i++) sum[i] += r[i];
  }
  return sum;
}
function jointLoss(filters, freqs, correctionDb, fs) {
  const fr = totalResponse(filters, freqs, fs);
  const tgt = correctionDb.slice();
  let ix10k = freqs.length;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= IX_10K_CUTOFF) {
      ix10k = i;
      break;
    }
  }
  if (ix10k < freqs.length) {
    let tgtSum = 0, frSum = 0, cnt = 0;
    for (let i = ix10k; i < tgt.length; i++) {
      tgtSum += tgt[i];
      frSum += fr[i];
      cnt++;
    }
    const tgtAvg = tgtSum / cnt, frAvg = frSum / cnt;
    for (let i = ix10k; i < tgt.length; i++) {
      tgt[i] = tgtAvg;
      fr[i] = frAvg;
    }
  }
  let minIx = 0, maxIx = freqs.length - 1;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= LOSS_FREQ_MIN) {
      minIx = i;
      break;
    }
  }
  for (let i = freqs.length - 1; i >= 0; i--) {
    if (freqs[i] <= LOSS_FREQ_MAX) {
      maxIx = i;
      break;
    }
  }
  let mse = 0;
  const n = maxIx - minIx + 1;
  for (let i = minIx; i <= maxIx; i++) {
    const diff = tgt[i] - fr[i];
    mse += diff * diff;
  }
  mse /= n;
  for (const f of filters) {
    mse += sharpnessPenalty(f.type, f.fc, f.gain, f.Q, freqs, fs);
  }
  return Math.sqrt(mse);
}
function encodeParams(filters) {
  const x = [];
  for (const f of filters) {
    x.push(Math.log10(f.fc));
    x.push(f.Q);
    x.push(f.gain);
  }
  return x;
}
function decodeParams(x, specs) {
  const filters = [];
  let idx = 0;
  for (const s of specs) {
    filters.push({
      type: s.type,
      fc: Math.pow(10, x[idx]),
      Q: x[idx + 1],
      gain: x[idx + 2]
    });
    idx += 3;
  }
  return filters;
}
function buildBounds(specs) {
  const lo = [], hi = [];
  for (const s of specs) {
    lo.push(Math.log10(s.fcRange[0]));
    hi.push(Math.log10(s.fcRange[1]));
    lo.push(s.qRange[0]);
    hi.push(s.qRange[1]);
    lo.push(s.gainRange[0]);
    hi.push(s.gainRange[1]);
  }
  return { lo, hi };
}
function finiteDiffGradient(x, f0, lossFn, bounds) {
  const n = x.length;
  const g = new Array(n);
  for (let i = 0; i < n; i++) {
    const xp = x.slice();
    xp[i] = Math.min(x[i] + FD_H, bounds.hi[i]);
    const fp = lossFn(xp);
    const actualH = xp[i] - x[i];
    g[i] = actualH > 0 ? (fp - f0) / actualH : 0;
  }
  return g;
}
function lbfgsTwoLoop(g, history) {
  const n = g.length;
  const k = history.length;
  if (k === 0) {
    return g.map((v) => -v);
  }
  const q = g.slice();
  const alpha = new Array(k);
  const rho = new Array(k);
  for (let i = 0; i < k; i++) {
    const dot = vecDot(history[i].y, history[i].s);
    rho[i] = dot > 0 ? 1 / dot : 0;
  }
  for (let i = k - 1; i >= 0; i--) {
    alpha[i] = rho[i] * vecDot(history[i].s, q);
    for (let j = 0; j < n; j++) q[j] -= alpha[i] * history[i].y[j];
  }
  const last = history[k - 1];
  const ys = vecDot(last.y, last.s);
  const yy = vecDot(last.y, last.y);
  const gamma = yy > 0 ? ys / yy : 1;
  const r = q.map((v) => gamma * v);
  for (let i = 0; i < k; i++) {
    const beta = rho[i] * vecDot(history[i].y, r);
    for (let j = 0; j < n; j++) r[j] += history[i].s[j] * (alpha[i] - beta);
  }
  return r.map((v) => -v);
}
function vecDot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function vecNorm(a) {
  return Math.sqrt(vecDot(a, a));
}
function projectToBounds(d, x, bounds) {
  for (let i = 0; i < d.length; i++) {
    if (x[i] <= bounds.lo[i] && d[i] < 0) d[i] = 0;
    if (x[i] >= bounds.hi[i] && d[i] > 0) d[i] = 0;
  }
}
function armijoLineSearch(x, d, g, f0, lossFn, bounds) {
  const c1 = 1e-4;
  const rho = 0.5;
  const maxSteps = 20;
  const slope = vecDot(g, d);
  let alpha = 1;
  let xTry;
  for (let step = 0; step < maxSteps; step++) {
    xTry = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      xTry[i] = Math.max(bounds.lo[i], Math.min(bounds.hi[i], x[i] + alpha * d[i]));
    }
    const fTry = lossFn(xTry);
    if (fTry <= f0 + c1 * alpha * slope) return xTry;
    alpha *= rho;
  }
  return xTry;
}
function populationStd(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  const mean = sum / arr.length;
  let ss = 0;
  for (let i = 0; i < arr.length; i++) ss += (arr[i] - mean) * (arr[i] - mean);
  return Math.sqrt(ss / arr.length);
}
function converged(lossHistory) {
  const len = lossHistory.length;
  if (len < MIN_ITER) return false;
  if (len > STD_WINDOW) {
    if (populationStd(lossHistory.slice(-STD_WINDOW)) < MIN_STD) return true;
  }
  if (len > 4) {
    if (populationStd(lossHistory.slice(-4)) < MIN_STD / 2) return true;
  }
  return false;
}
function jointOptimize(initialFilters, specs, freqs, correctionDb, fs) {
  let x = encodeParams(initialFilters);
  const bounds = buildBounds(specs);
  const lossFn = (params) => {
    const filters = decodeParams(params, specs);
    return jointLoss(filters, freqs, correctionDb, fs);
  };
  let loss0 = lossFn(x);
  let g = finiteDiffGradient(x, loss0, lossFn, bounds);
  let bestLoss = loss0;
  let bestX = x.slice();
  const lossHistory = [];
  const lbfgsHistory = [];
  for (let iter = 0; iter < MAX_JOINT_ITER; iter++) {
    const d = lbfgsTwoLoop(g, lbfgsHistory);
    projectToBounds(d, x, bounds);
    if (vecNorm(d) < 1e-10) break;
    const xNew = armijoLineSearch(x, d, g, loss0, lossFn, bounds);
    const loss1 = lossFn(xNew);
    const gNew = finiteDiffGradient(xNew, loss1, lossFn, bounds);
    const s = new Array(x.length);
    const y = new Array(x.length);
    for (let i = 0; i < x.length; i++) {
      s[i] = xNew[i] - x[i];
      y[i] = gNew[i] - g[i];
    }
    const ys = vecDot(y, s);
    if (ys > 1e-10 * vecNorm(s) * vecNorm(y)) {
      lbfgsHistory.push({ s, y });
      if (lbfgsHistory.length > LBFGS_MEMORY) lbfgsHistory.shift();
    }
    x = xNew;
    g = gNew;
    loss0 = loss1;
    if (loss1 < bestLoss) {
      bestLoss = loss1;
      bestX = x.slice();
    }
    lossHistory.push(loss1);
    if (converged(lossHistory)) break;
  }
  return decodeParams(bestX, specs);
}
function computePregain(filters, freqs, fs, gainRange) {
  if (filters.length === 0) return 0;
  const resp = totalResponse(filters, freqs, fs);
  const maxBoost = Math.max(...resp);
  if (maxBoost <= 0) return 0;
  const pregain = -(maxBoost + PREAMP_HEADROOM);
  return Math.max(gainRange[0], Math.min(gainRange[1], pregain));
}
function optimize(measured, target, constraints = {}) {
  const fs = constraints.fs || DEFAULT_FS2;
  const freqRange = constraints.freqRange || [20, 1e4];
  const specs = resolveSpecs(constraints, freqRange);
  const measInterp = interpolate(measured, PIPELINE_GRID);
  const targetInterp = interpolate(target, PIPELINE_GRID);
  const ix1k = measInterp.findIndex((pt) => pt.freq >= 1e3);
  const offset1k = measInterp[ix1k].db;
  const measCentered = measInterp.map((pt) => ({ freq: pt.freq, db: pt.db - offset1k }));
  const error = compensate(measCentered, targetInterp);
  const equalizationPipeline = equalize(error);
  const eqOnOptGrid = interpolate(equalizationPipeline, OPTIMIZER_GRID);
  const optFreqs = eqOnOptGrid.map((pt) => pt.freq);
  const correctionDb = eqOnOptGrid.map((pt) => pt.db);
  const typeOrder = { HSQ: 2, LSQ: 1, PK: 0 };
  const initOrder = specs.map((s, i) => ({
    idx: i,
    order: typeOrder[s.type] * 100 + (s.fcRange[1] > s.fcRange[0] ? 1 / Math.log2(s.fcRange[1] / s.fcRange[0]) : 0)
  }));
  initOrder.sort((a, b) => b.order - a.order);
  const initialFilters = new Array(specs.length);
  const remaining = correctionDb.slice();
  for (const { idx } of initOrder) {
    const filt = initFilter(optFreqs, remaining, specs[idx], fs);
    initialFilters[idx] = filt;
    const resp = biquadResponse(filt.type, filt.fc, filt.gain, filt.Q, optFreqs, fs);
    for (let i = 0; i < remaining.length; i++) remaining[i] -= resp[i];
  }
  const optimized = jointOptimize(initialFilters, specs, optFreqs, correctionDb, fs);
  const overallGainRange = [
    Math.min(...specs.map((s) => s.gainRange[0])),
    Math.max(...specs.map((s) => s.gainRange[1]))
  ];
  const pregain = computePregain(optimized, optFreqs, fs, overallGainRange);
  return {
    pregain: Math.round(pregain * 1e4) / 1e4,
    filters: optimized.map((f) => ({
      type: f.type,
      fc: Math.round(f.fc * 100) / 100,
      gain: Math.round(f.gain * 1e4) / 1e4,
      Q: Math.round(f.Q * 1e4) / 1e4
    }))
  };
}

// src/applyFilters.js
function applyFilters(fr, filters, pregain, fs = 44100) {
  const frequencies = fr.map((pt) => pt.freq);
  const filterSum = new Array(fr.length).fill(0);
  for (const { type, fc, gain, Q } of filters) {
    const response = biquadResponse(type, fc, gain, Q, frequencies, fs);
    for (let i = 0; i < filterSum.length; i++) {
      filterSum[i] += response[i];
    }
  }
  return fr.map((pt, i) => ({
    freq: pt.freq,
    db: pt.db + filterSum[i] + pregain
  }));
}
export {
  applyFilters,
  biquadResponse,
  compensate,
  equalize,
  interpolate,
  optimize,
  smooth
};
