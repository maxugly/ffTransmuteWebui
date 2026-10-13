"""Small persisted timing history: observed load cost plus synthesis cost per word."""
import hashlib
import json
import math
from ..media.performance import SETTINGS_PATH

PATH = SETTINGS_PATH.with_name('tts-timings.json')


def key(recipe, voice, quality, controls):
    value = [recipe['revision'], voice, quality, controls]
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def history():
    try:
        data = json.loads(PATH.read_text())
        if not isinstance(data, dict):
            return {}
        clean = {}
        for bucket, rows in data.items():
            if not isinstance(rows, list):
                continue
            valid = [r for r in rows if isinstance(r, dict) and all(isinstance(r.get(k), (int,float)) and math.isfinite(r[k]) and r[k] >= 0 for k in ('words','load_s','inference_s','export_s')) and isinstance(r.get('reused'), bool)]
            if valid:
                clean[bucket] = valid[-24:]
        return clean
    except (OSError, ValueError):
        return {}


def estimate(bucket, words, reused):
    rows = history().get(bucket, [])
    valid = [r for r in rows if r['words'] > 0]
    if not valid:
        return None
    loads = [r['load_s'] for r in valid if not r['reused']]
    # No cold observations means no honest cold-load ETA yet.
    if not reused and not loads:
        return None
    load = 0 if reused else sum(loads)/len(loads)
    seconds_per_word = sum(r['inference_s'] for r in valid)/sum(r['words'] for r in valid)
    export = sum(r['export_s'] for r in valid)/len(valid)
    return round(load + words*seconds_per_word + export, 2)


def record(bucket, words, metrics, export_s):
    values = [metrics.get('load_s'), metrics.get('inference_s'), export_s]
    if not words or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in values):
        return
    data = history()
    data[bucket] = (data.get(bucket, []) + [{'words': words, 'load_s': values[0],
        'inference_s': values[1], 'export_s': export_s, 'reused': metrics.get('reused', False)}])[-24:]
    while len(data) > 128:
        data.pop(next(iter(data)))
    try:
        PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = PATH.with_suffix('.tmp')
        tmp.write_text(json.dumps(data))
        tmp.replace(PATH)
    except OSError:
        import logging
        logging.getLogger('mtapi').warning('Could not persist TTS timing history', exc_info=True)
