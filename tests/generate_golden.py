#!/usr/bin/env python3
"""
generate_golden.py

Runs AutoEq on each IEM × target × constraint combination and writes
golden files to tests/fixtures/golden/.

Usage:
    python tests/generate_golden.py
    python tests/generate_golden.py --force   # regenerate existing files
"""

import argparse
import json
import sys
import numpy as np
from copy import deepcopy
from pathlib import Path

from autoeq.frequency_response import FrequencyResponse
from autoeq.constants import PREAMP_HEADROOM

SCRIPT_DIR = Path(__file__).parent
FR_DIR     = SCRIPT_DIR / 'fixtures' / 'fr'
TARGET_DIR = SCRIPT_DIR / 'fixtures' / 'targets'
GOLDEN_DIR = SCRIPT_DIR / 'fixtures' / 'golden'

GOLDEN_DIR.mkdir(exist_ok=True)

FS = 44100

IEMS = ['blessing3', 'hexa', 'andromeda', 'zero2', 'origin_s']

TARGETS = ['harman_ie_2019', 'diffuse_field', 'flat', 'v_shaped', 'bass_heavy', 'bright']

# Each constraint set is an AutoEq PEQ config dict.
# Shelf filters use AutoEq's default Q range (0.4–0.7) to stay well-behaved.
# Peaking Q range and gain range are set explicitly per constraint.
CONSTRAINTS = {
    'standard': {
        'filters': [
            {'type': 'LOW_SHELF',  'min_gain': -12.0, 'max_gain': 12.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'HIGH_SHELF', 'min_gain': -12.0, 'max_gain': 12.0},
        ]
    },
    'restricted': {
        'filters': [
            {'type': 'PEAKING', 'min_gain': -6.0, 'max_gain': 6.0, 'min_q': 1.0, 'max_q': 5.0},
            {'type': 'PEAKING', 'min_gain': -6.0, 'max_gain': 6.0, 'min_q': 1.0, 'max_q': 5.0},
            {'type': 'PEAKING', 'min_gain': -6.0, 'max_gain': 6.0, 'min_q': 1.0, 'max_q': 5.0},
        ]
    },
    'qudelix_10': {
        'filters': [
            {'type': 'LOW_SHELF',  'min_gain': -12.0, 'max_gain': 12.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'PEAKING',    'min_gain': -12.0, 'max_gain': 12.0, 'min_q': 0.5, 'max_q': 10.0},
            {'type': 'HIGH_SHELF', 'min_gain': -12.0, 'max_gain': 12.0},
        ]
    },
}

TYPE_MAP = {'LowShelf': 'LSQ', 'Peaking': 'PK', 'HighShelf': 'HSQ'}


def load_fr_json(path):
    """Load [{freq, db}] JSON → (freq_array, db_array)."""
    with open(path) as f:
        data = json.load(f)
    return (
        np.array([p['freq'] for p in data]),
        np.array([p['db']   for p in data]),
    )


def run_pipeline(iem_name, iem_freqs, iem_dbs, target_name, target_freqs, target_dbs, config):
    """Run full AutoEq pipeline. Returns (filters, pregain, rmse)."""
    # Build IEM FrequencyResponse
    fr = FrequencyResponse(name=iem_name, frequency=iem_freqs.copy(), raw=iem_dbs.copy())
    fr.interpolate()
    fr.center()

    # Build target FrequencyResponse (compensate() will re-interpolate internally)
    target = FrequencyResponse(name=target_name, frequency=target_freqs.copy(), raw=target_dbs.copy())

    # AutoEq pipeline
    fr.compensate(target)   # sets fr.error = fr.raw - fr.target
    fr.smoothen()           # sets fr.error_smoothed
    fr.equalize()           # sets fr.equalization ≈ -fr.error_smoothed

    # PEQ optimization — deepcopy config since from_dict mutates filter dicts in place
    peqs = fr.optimize_parametric_eq([deepcopy(config)], FS)
    # fr.parametric_eq is now set to the sum of all filter FRs on fr.frequency grid

    # Flatten all filters from all PEQ passes
    filters = []
    for peq in peqs:
        for filt in peq.filters:
            filters.append({
                'type': TYPE_MAP[filt.__class__.__name__],
                'freq': round(float(filt.fc),   2),
                'gain': round(float(filt.gain),  4),
                'q':    round(float(filt.q),     4),
            })

    # Pregain: headroom to prevent clipping
    pregain = round(float(-np.max(fr.parametric_eq) - PREAMP_HEADROOM), 4)

    # RMSE: corrected IEM FR vs target, no pregain (shape comparison only)
    # fr.raw = centered interpolated IEM FR
    # fr.parametric_eq = sum of PEQ filter FRs (same frequency grid)
    # fr.target = target curve on same frequency grid (set by compensate())
    corrected = fr.raw + fr.parametric_eq
    rmse = round(float(np.sqrt(np.mean(np.square(corrected - fr.target)))), 6)

    return filters, pregain, rmse


def main():
    parser = argparse.ArgumentParser(description='Generate biquad-fit golden files via AutoEq')
    parser.add_argument('--force', action='store_true', help='Regenerate existing files')
    args = parser.parse_args()

    total = len(IEMS) * len(TARGETS) * len(CONSTRAINTS)
    done = skipped = errors = 0

    for iem_name in IEMS:
        iem_freqs, iem_dbs = load_fr_json(FR_DIR / f'{iem_name}.json')

        for target_name in TARGETS:
            target_freqs, target_dbs = load_fr_json(TARGET_DIR / f'{target_name}.json')

            for constraint_name, config in CONSTRAINTS.items():
                out_path = GOLDEN_DIR / f'{iem_name}_{target_name}_{constraint_name}.json'

                if out_path.exists() and not args.force:
                    print(f'  skip  {out_path.name}')
                    skipped += 1
                    done += 1
                    continue

                try:
                    filters, pregain, rmse = run_pipeline(
                        iem_name, iem_freqs, iem_dbs,
                        target_name, target_freqs, target_dbs,
                        config,
                    )

                    golden = {
                        'iem':        iem_name,
                        'target':     target_name,
                        'constraint': constraint_name,
                        'fs':         FS,
                        'pregain':    pregain,
                        'filters':    filters,
                        'rmse':       rmse,
                    }

                    with open(out_path, 'w') as f:
                        json.dump(golden, f, indent=2)

                    done += 1
                    print(
                        f'  ✓  {out_path.name}'
                        f'  (rmse={rmse:.3f} dB, {len(filters)} filters, pregain={pregain:.1f} dB)'
                    )

                except Exception as e:
                    errors += 1
                    print(f'  ✗  {iem_name} × {target_name} × {constraint_name}: {e}', file=sys.stderr)
                    import traceback; traceback.print_exc(file=sys.stderr)

    print(f'\n{done}/{total} done ({skipped} skipped, {errors} errors)')


if __name__ == '__main__':
    main()
