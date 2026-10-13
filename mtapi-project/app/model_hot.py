"""Per-tool retention and read-only global model residency. Navigation has no side effects."""
import asyncio
import gc
import json
import shutil
import sys
import uuid
from pathlib import Path
from contextlib import contextmanager
from contextvars import ContextVar
from collections import Counter
import threading
from . import job_control
from .model_inventory import TABS, disk_info, selection
from . import shell
from .media.performance import load_settings, save_settings

ROOT = Path(__file__).resolve().parents[1]
ACTIVE = 0
_ACTIVE_TOOLS = Counter()
_OBSERVED = {}
_STATE_LOCK = threading.RLock()
_JOB_TOKEN = ContextVar('model_job_token', default=None)
_JOB_TOOL = ContextVar('model_job_tool', default=None)
_worker = None
_worker_dir = None
_worker_key = None
_worker_meta = None
_lock = asyncio.Lock()
_LIFECYCLE_LOCK = asyncio.Lock()

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

CACHE_OWNERS = {
    'app.operations.deepdream_ov_engine': 'deepdream',
    'app.operations.deepdream_ov_engine_v2': 'deepdream',
    'app.operations.deepdream_ov_engine_v3': 'deepdream',
    'app.operations.deepdream.models': 'deepdream',
    'app.operations.styletransfer_ov_engine': 'styletransfer',
    'app.operations.styletransfer_engine': 'styletransfer',
    'app.operations.demucs_ov_engine': 'demucs',
    'app.filters.erase': 'erase', 'app.filters.fastsam': 'fastsam',
    'app.operations.withoutbg_engine': 'withoutbg',
}
CACHES.update({
    'app.operations.deepdream_ov_engine_v2': ('clear_cache', '_compiled'),
    'app.operations.deepdream_ov_engine_v3': ('clear_cache', '_compiled'),
    'app.operations.withoutbg_engine': (None, '_local_model'),
})


def owner_for(operation):
    if operation.startswith('tts_'): return 'tts'
    if operation.startswith('music_'): return 'music'
    if operation.startswith('demucs_'): return 'demucs'
    if operation.startswith('erase_'): return 'erase'
    if operation.startswith('deepdream_'): return 'deepdream'
    if operation.startswith('styletransfer_'): return 'styletransfer'
    if operation == 'rife_recohere': return 'riferecohere'
    if operation.startswith('seq_') or operation.startswith('sequence'): return 'sequence'
    return operation if operation in TABS else None


def enabled(tool):
    return bool(load_settings().get('warm_models', {}).get(tool, False))


def start_loading(tool, model, paths=()):
    key = uuid.uuid4().hex
    entry = {'tool': tool, 'model': str(model), 'engine': TABS[tool][0],
             'state': 'loading', 'token': _JOB_TOKEN.get() or job_control.current_token(),
             'paths': [str(Path(p).expanduser().absolute()) for p in paths]}
    consumer = _JOB_TOOL.get()
    if not consumer and entry['token']:
        progress = job_control.get_progress(entry['token']) or {}
        consumer = owner_for(progress.get('operation', ''))
    entry['tabs'] = list({tool, consumer} - {None})
    with _STATE_LOCK:
        _OBSERVED[key] = entry
    return key


@contextmanager
def loading(tool, model, paths=()):
    """Called at real load boundaries, never on a tab switch or status read."""
    key = start_loading(tool, model, paths)
    try:
        yield key
    except BaseException:
        forget(key)
        raise
    else:
        loaded(key)


def loaded(key):
    with _STATE_LOCK:
        if key in _OBSERVED: _OBSERVED[key]['state'] = 'loaded'


def forget(key):
    with _STATE_LOCK:
        _OBSERVED.pop(key, None)


def status(tab='', **selected):
    resident = []
    for name, (_, attr) in CACHES.items():
        module = sys.modules.get(name)
        cache = getattr(module, attr, None)
        if name == 'app.filters.fastsam' and isinstance(cache, dict):
            cache = {key: value for key, value in list(cache.items()) if getattr(value, 'predictor', True) is not None and getattr(getattr(value, 'predictor', True), 'model', True) is not None}
        if cache is not None and (not isinstance(cache, dict) or len(cache)):
            tool = CACHE_OWNERS.get(name)
            resident.append({'tool': tool, 'engine': TABS.get(tool, (name.rsplit('.',1)[-1],))[0],
                'model': ', '.join(str(k) for k in list(cache)[:4]) if isinstance(cache, dict) else TABS[tool][0],
                'models': len(cache) if isinstance(cache, dict) else 1, 'state': 'loaded'})
    if _worker_meta and _worker and not _worker.done():
        resident.append({'tool': 'tts', 'engine': 'TTS', 'state': 'loaded', **_worker_meta})
    with _STATE_LOCK:
        observed = [dict(e) for e in _OBSERVED.values()]
    loading_models = [e for e in observed if e['state'] == 'loading']
    for entry in observed:
        if entry['state'] == 'loaded' and not any(r['tool'] == entry['tool'] and r.get('model') == entry['model'] for r in resident):
            resident.append(entry)
    # The worker writes a phase file after its loader returns. Export/playback are not residency.
    tts = sys.modules.get('app.audio.tts')
    if tts:
        for token, job in list(tts.TASKS.items()):
            if not job.get('model_running'): continue
            current = tts.job_status(token)
            entry = {'tool': 'tts', 'engine': 'TTS', 'model': current.get('model_label', 'TTS'),
                     'paths': current.get('model_paths', []), 'state': 'loading'}
            if current.get('message') == 'Synthesizing speech':
                entry['state'] = 'loaded'
                if not any(r['tool'] == 'tts' for r in resident): resident.append(entry)
            elif not any(e['tool'] == 'tts' for e in loading_models): loading_models.append(entry)
    for entries in (resident, loading_models):
        for entry in entries:
            if entry.get('paths'): entry.update(disk_info(entry['paths']))
            entry.pop('token', None)
    policies = {tool: enabled(tool) for tool, (_, retain) in TABS.items() if retain}
    payload = {'ok': True, 'policies': policies, 'tabs': {k: {'label': v[0], 'retention_supported': v[1]} for k,v in TABS.items()},
        'resident': resident, 'loading': loading_models, 'active': ACTIVE,
        'release_pending': [tool for tool in policies if not policies[tool] and ACTIVE and any(r['tool'] == tool for r in resident)]}
    if tab in TABS:
        payload['selection'] = selection(tab, **selected)
    return payload


def tts_reused(engine, model_dir):
    return enabled('tts') and _worker_key == (engine, str(model_dir)) and _worker_meta is not None and _worker is not None and not _worker.done()


async def begin(tool=None, token=None):
    global ACTIVE
    async with _LIFECYCLE_LOCK:
        ACTIVE += 1
        if tool: _ACTIVE_TOOLS[tool] += 1
    _JOB_TOKEN.set(token)
    _JOB_TOOL.set(tool)


async def finish(tool=None, token=None):
    global ACTIVE
    ACTIVE = max(0, ACTIVE - 1)
    if tool: _ACTIVE_TOOLS[tool] = max(0, _ACTIVE_TOOLS[tool]-1)
    with _STATE_LOCK:
        for key, entry in list(_OBSERVED.items()):
            if ACTIVE == 0 or (token and entry['token'] == token): _OBSERVED.pop(key, None)
    # A pipeline can load models owned by several tools; release only idle cold owners.
    for owner, (_, retain) in TABS.items():
        if retain and not enabled(owner) and not _ACTIVE_TOOLS[owner] and ACTIVE == 0:
            await release(owner)


def _clear_native(tool=None):
    changed = False
    for name, (clear, attr) in CACHES.items():
        if tool and CACHE_OWNERS.get(name) != tool: continue
        module = sys.modules.get(name)
        if module is None: continue
        cache = getattr(module, attr, None)
        if cache is None or (isinstance(cache, dict) and not cache): continue
        changed = True
        if clear:
            getattr(module, clear)()
        else:
            cache = getattr(module, attr, None)
            if isinstance(cache, dict): cache.clear()
            elif cache is not None: setattr(module, attr, None)
    if changed: gc.collect()


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


async def release(tool=None):
    # Protect pipeline/shared users too; deferred cleanup is run at final job completion.
    async with _LIFECYCLE_LOCK:
        if ACTIVE or (tool and enabled(tool)): return
        async with _lock:
            if tool in (None, 'tts'): await _stop_worker()
            if tool != 'tts': await asyncio.to_thread(_clear_native, tool)
            with _STATE_LOCK:
                for key, entry in list(_OBSERVED.items()):
                    if tool is None or entry['tool'] == tool: _OBSERVED.pop(key, None)


_CONFIG_LOCK = asyncio.Lock()


async def configure(tool, value):
    if tool not in TABS or not TABS[tool][1]:
        raise ValueError('Choose a tool with resident-model support')
    if not isinstance(value, bool): raise ValueError('enabled must be true or false')
    async with _CONFIG_LOCK:
        settings = load_settings()
        await save_settings({**settings, 'warm_models': {**settings.get('warm_models', {}), tool: value}})
    if not value: await release(tool)
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
        if result.get('model_loaded', result['ok']):
            _worker_meta = {'model': engine, 'checkpoint': str(model_dir), 'paths': [str(model_dir)], 'pid': result['pid'], 'loads': result['loads']}
        else:
            _worker_meta = None
        if not result['ok']:
            raise RuntimeError(result['error'])
        return result
