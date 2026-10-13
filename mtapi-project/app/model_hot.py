"""Shared resident-model policy; clearing is deferred until all active jobs finish."""
import asyncio
import gc
import json
import shutil
import sys
import uuid
from pathlib import Path
from . import shell
from .media.performance import load_settings, save_settings

ROOT = Path(__file__).resolve().parents[1]
ACTIVE = 0
_worker = None
_worker_dir = None
_worker_key = None
_worker_meta = None
_lock = asyncio.Lock()

# Only import-free lookups: toggling must never load an unused neural library.
CACHES = {
    'app.operations.deepdream_ov_engine': ('clear_cache', '_compiled'),
    'app.operations.styletransfer_ov_engine': ('clear_cache', '_compiled'),
    'app.operations.demucs_ov_engine': ('unload_all', '_compiled'),
    'app.filters.erase': ('clear_compiled_cache', '_COMPILED'),
    'app.filters.fastsam': (None, '_runtime_model_cache'),
    'app.operations.deepdream.models': (None, '_base_model_cache'),
    'app.operations.styletransfer_engine': (None, '_model'),
}

def enabled():
    return load_settings().get('keep_models_hot', False)


def status():
    resident = []
    for name, (_, attr) in CACHES.items():
        module = sys.modules.get(name)
        cache = getattr(module, attr, None)
        if cache:
            resident.append({'engine': name.rsplit('.', 1)[-1], 'models': len(cache) if isinstance(cache, dict) else 1})
    if _worker_meta and _worker and not _worker.done():
        resident.append({'engine': 'tts', **_worker_meta})
    return {'ok': True, 'enabled': enabled(), 'resident': resident, 'active': ACTIVE,
            'release_pending': not enabled() and ACTIVE > 0,
            'supported': ['TTS: Piper, Kokoro, Supertonic, Kitten', 'DeepDream', 'Style Transfer', 'FastSAM', 'Stems / Demucs', 'Erase / LaMa'],
            'one_shot': ['DECtalk (native command)', 'Music', 'Txt2Img', 'Img2Img', 'external CLI engines']}


def tts_reused(engine, model_dir):
    return enabled() and _worker_key == (engine, str(model_dir)) and _worker_meta is not None and _worker is not None and not _worker.done()

def begin():
    global ACTIVE
    ACTIVE += 1


async def finish():
    global ACTIVE
    ACTIVE = max(0, ACTIVE - 1)
    if not enabled() and ACTIVE == 0:
        await release()


def _clear_native():
    for name, (clear, attr) in CACHES.items():
        module = sys.modules.get(name)
        if module is None:
            continue
        if clear:
            getattr(module, clear)()
        else:
            cache = getattr(module, attr, None)
            if isinstance(cache, dict):
                cache.clear()
            elif cache is not None:
                setattr(module, attr, None)
    gc.collect()


async def _stop_worker():
    global _worker, _worker_dir, _worker_key, _worker_meta
    if _worker:
        (_worker_dir/'stop').touch()
        await _worker
        shutil.rmtree(_worker_dir, ignore_errors=True)
    _worker = _worker_dir = _worker_key = _worker_meta = None


async def invalidate_tts():
    async with _lock:
        await _stop_worker()


async def release():
    if ACTIVE:
        return
    async with _lock:
        await _stop_worker()
        await asyncio.to_thread(_clear_native)


async def configure(value):
    if not isinstance(value, bool):
        raise ValueError('enabled must be true or false')
    await save_settings({**load_settings(), 'keep_models_hot': value})
    if not value:
        await release()
    return status()


async def synthesize(engine, model_dir, voice, quality, controls, text_file, output):
    """Keep one isolated TTS model resident, replacing it when its checkpoint changes."""
    global _worker, _worker_dir, _worker_key, _worker_meta
    async with _lock:
        key = (engine, str(model_dir))
        if _worker_key != key or not _worker or _worker.done():
            await _stop_worker()
            _worker_dir = ROOT/'junk'/'model-hot'/uuid.uuid4().hex
            _worker_dir.mkdir(parents=True)
            _worker_key = key
            _worker = asyncio.create_task(shell.run_command([sys.executable, str(ROOT/'tools'/'tts_worker.py'), '--serve', str(_worker_dir)]))
        token = uuid.uuid4().hex
        request = _worker_dir/(token+'.request.json')
        staging = request.with_suffix('.tmp')
        staging.write_text(json.dumps({'engine': engine, 'model_dir': str(model_dir), 'voice': voice,
            'quality': quality, 'controls': json.dumps(controls), 'text_file': str(text_file), 'output': str(output), 'check': False, 'phase_file': str(Path(text_file).with_suffix('.phase'))}))
        staging.replace(request)
        response = _worker_dir/(token+'.response.json')
        while not response.exists():
            if _worker.done():
                code, _, error = await _worker
                raise RuntimeError(f'Resident TTS worker exited ({code}): {error[-2000:]}')
            await asyncio.sleep(.05)
        result = json.loads(response.read_text())
        response.unlink()
        if not result['ok']:
            raise RuntimeError(result['error'])
        _worker_meta = {'model': engine, 'pid': result['pid'], 'loads': result['loads']}
        return result
