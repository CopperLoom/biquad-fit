#!/usr/bin/env python3
"""
autoeq_run.py

AutoEQ helper for compare.js. Reads JSON from stdin:
  {
    "fr":     [{freq, db}, ...],
    "target": [{freq, db}, ...],
    "config": { "filters": [{type, min_gain, max_gain, min_q, max_q, min_fc, max_fc}, ...] }
  }

Outputs JSON to stdout:
  { "filters": [{type, freq, gain, q}, ...], "pregain": float, "rmse": float }
"""

import json
import sys
import numpy as np
from copy import deepcopy

from autoeq.frequency_response import FrequencyResponse
from autoeq.constants import PREAMP_HEADROOM

TYPE_MAP = {'LowShelf': 'LSQ', 'Peaking': 'PK', 'HighShelf': 'HSQ'}


def main():
    data   = json.load(sys.stdin)
    config = data['config']

    fr_pts  = data['fr']
    tgt_pts = data['target']

    fr = FrequencyResponse(
        name='fr',
        frequency=np.array([p['freq'] for p in fr_pts]),
        raw=np.array([p['db'] for p in fr_pts]),
    )
    fr.interpolate()
    fr.center()

    target = FrequencyResponse(
        name='target',
        frequency=np.array([p['freq'] for p in tgt_pts]),
        raw=np.array([p['db'] for p in tgt_pts]),
    )

    fr.compensate(target)
    fr.smoothen()
    fr.equalize()

    peqs = fr.optimize_parametric_eq([deepcopy(config)], 44100)

    filters = []
    for peq in peqs:
        for filt in peq.filters:
            filters.append({
                'type': TYPE_MAP[filt.__class__.__name__],
                'freq': round(float(filt.fc),   2),
                'gain': round(float(filt.gain),  4),
                'q':    round(float(filt.q),     4),
            })

    pregain   = round(float(-np.max(fr.parametric_eq) - PREAMP_HEADROOM), 4)
    corrected = fr.raw + fr.parametric_eq
    rmse      = round(float(np.sqrt(np.mean(np.square(corrected - fr.target)))), 6)

    print(json.dumps({'filters': filters, 'pregain': pregain, 'rmse': rmse}))


if __name__ == '__main__':
    main()
