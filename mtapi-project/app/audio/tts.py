"""Versioned local TTS recipes. Downloads stage and validate before activation."""
import asyncio
import hashlib
import importlib.metadata
import json
import shutil
import sys
import time
import uuid
from pathlib import Path
import httpx
from .. import shell, job_control
from .export import FORMATS, convert_audio, export_args
from .tts_controls import CAPABILITIES, validate_controls
from . import tts_timing

ROOT = Path(__file__).resolve().parents[2]
MODEL_ROOT = ROOT / 'junk' / 'tts-models'
PREVIEW_ROOT = ROOT / 'junk' / 'tts-preview'
HF_COMMIT = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117'
PIPER_BASE = f'https://huggingface.co/rhasspy/piper-voices/resolve/{HF_COMMIT}/en/en_US/lessac/medium/'
RECIPES = {
    'piper-lessac': {'label': 'Piper · Lessac · English US', 'engine': 'piper', 'package': 'piper-tts', 'runtime': '1.8.0', 'revision': f'lessac-{HF_COMMIT[:12]}-piper1.8.0', 'license': 'Piper runtime GPL-3.0; each voice has its own dataset license', 'source': 'https://github.com/OHF-Voice/piper1-gpl', 'voice': 'lessac', 'files': [
        {'name': 'voice.onnx', 'url': PIPER_BASE+'en_US-lessac-medium.onnx', 'size': 63201294, 'sha256': '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f'},
        {'name': 'voice.onnx.json', 'url': PIPER_BASE+'en_US-lessac-medium.onnx.json', 'size': 4885, 'sha256': 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0'},
    ]},
    'kokoro': {'label': 'Kokoro v1.0 · English US', 'engine': 'kokoro', 'package': 'kokoro-onnx', 'runtime': '0.6.1', 'revision': 'model-files-v1.0-kokoro0.6.1', 'license': 'Kokoro model Apache-2.0; runtime MIT', 'source': 'https://github.com/thewh1teagle/kokoro-onnx', 'voice': 'af_heart', 'files': [
        {'name': 'kokoro.onnx', 'url': 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx', 'size': 325532387, 'sha256': '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5'},
        {'name': 'voices.bin', 'url': 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin', 'size': 28214398, 'sha256': 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'},
    ]},
    'dectalk-paul': {'label': 'DECtalk · Perfect Paul (Stephen Hawking)', 'engine': 'dectalk', 'package': 'dectalk', 'runtime': 'built-in', 'revision': 'dectalk-paul-v1', 'license': 'DECtalk proprietary / open community build', 'source': 'https://github.com/dectalk/dectalk', 'voice': 'paul', 'files': []},
}
MANIFEST = json.loads((Path(__file__).with_name('tts_catalog.json')).read_text())
RECIPES.update({m['id']: m for m in MANIFEST['modern']})
RECIPES['piper-lessac']['label'] = 'Piper · English voice library'
TASKS = {}
PREVIEWS = {}
ACTIVE = None
VERIFIED = {}


def model_path(recipe):
    return MODEL_ROOT / recipe['revision']


def artifacts_ready(recipe, path, receipt):
    if receipt.get('revision') != recipe['revision']:
        return False
    for file in recipe['files']:
        artifact = path/file['name']
        try:
            stat = artifact.stat()
            expected = file.get('sha256') or file['git_sha1']
            key = (str(artifact), stat.st_ino, stat.st_size, stat.st_mtime_ns, expected)
            if stat.st_size != file['size']:
                return False
            if key not in VERIFIED:
                with artifact.open('rb') as data:
                    VERIFIED[key] = (hashlib.file_digest(data, 'sha256').hexdigest() if file.get('sha256') else artifact_digest(file, data.read())) == expected
            if not VERIFIED[key]:
                return False
        except (OSError, KeyError):
            return False
    return True


def artifact_digest(file, data):
    if file.get('sha256'):
        return hashlib.sha256(data).hexdigest()
    return hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()


def qualities(model, voice):
    if model == 'piper-lessac':
        available = {v['quality'] for v in MANIFEST['piper'] if v['voice'] == voice}
        return [{'id': q, 'label': q.title()} for q in ('low', 'medium', 'high') if q in available]
    return RECIPES[model].get('qualities', [{'id': 'standard', 'label': 'Standard'}])


def selected_quality(payload):
    model = payload['model']
    voice = selected_voice(payload)
    options = qualities(model, voice)
    default = RECIPES[model].get('default_quality', 'medium' if model in ('piper-lessac','supertonic-3') else 'standard')
    default = default if any(q['id'] == default for q in options) else options[0]['id']
    quality = payload.get('quality', default)
    if not isinstance(quality, str) or not any(q['id'] == quality for q in options):
        raise ValueError('Choose an available quality for this voice')
    return quality


def selected_recipe(payload):
    model = payload['model']
    recipe = RECIPES[model]
    voice = selected_voice(payload)
    quality = selected_quality(payload)
    if model == 'piper-lessac':
        # Preserve the already installed Lessac medium recipe and older API clients.
        if voice == 'lessac' and quality == 'medium':
            return recipe
        variant = next(v for v in MANIFEST['piper'] if v['voice'] == voice and v['quality'] == quality)
        return recipe | variant
    if recipe.get('variants'):
        return recipe | next(v for v in recipe['variants'] if v['quality'] == quality)
    return recipe


def recipe_status(recipe):
    path = model_path(recipe)
    try:
        receipt = json.loads((path/'receipt.json').read_text())
        installed = artifacts_ready(recipe, path, receipt)
    except (OSError, ValueError, KeyError):
        installed = False
    try:
        runtime = importlib.metadata.version(recipe['package'])
    except importlib.metadata.PackageNotFoundError:
        runtime = None
    if recipe['engine'] == 'dectalk':
        installed = bool(shutil.which('dectalk-say') or Path('/home/m/.local/share/dectalk/say').exists())
        runtime = 'built-in' if installed else None
    ready = installed and runtime == recipe['runtime']
    return {'ready': ready, 'status': 'ready' if ready else ('upgrade' if installed or path.exists() else 'missing'),
            'bytes': sum(f['size'] for f in recipe['files']), 'installed_runtime': runtime}


def voice_choices(model):
    recipe = RECIPES[model]
    if model == 'piper-lessac':
        return list({v['voice']: {'id': v['voice'], 'label': v['label']} for v in MANIFEST['piper']}.values())
    if recipe.get('voices'):
        return recipe['voices']
    if recipe['engine'] == 'dectalk':
        return [{'id': key, 'label': label} for key, label in (
            ('paul', 'Perfect Paul'), ('betty', 'Beautiful Betty'),
            ('harry', 'Huge Harry'), ('dennis', 'Dense Dennis'),
            ('frank', 'Frail Frank'), ('rita', 'Rough Rita'),
            ('ursula', 'Uppity Ursula'), ('wendy', 'Whispering Wendy'), ('kit', 'Kit the Kid'))]
    if recipe['engine'] == 'kokoro':
        import zipfile
        try:
            with zipfile.ZipFile(model_path(recipe)/'voices.bin') as bank:
                keys = sorted(n[:-4] for n in bank.namelist() if n.endswith('.npy') and n[:2] in ('af', 'am', 'bf', 'bm'))
            return [{'id': key, 'label': key[3:].replace('_', ' ').title()+' · '+('US' if key[0]=='a' else 'UK')+' '+('female' if key[1]=='f' else 'male')} for key in keys]
        except (OSError, zipfile.BadZipFile):
            pass
    return [{'id': recipe['voice'], 'label': recipe['voice'].replace('_',' ').title()}]


def selected_voice(payload):
    recipe = RECIPES[payload['model']]
    voice = payload.get('voice', recipe['voice'])
    if not isinstance(voice, str) or voice not in {v['id'] for v in voice_choices(payload['model'])}:
        raise ValueError('Choose an available voice for this model')
    return voice


def catalog():
    models = []
    receipts = []
    for receipt_path in MODEL_ROOT.glob('*/receipt.json'):
        try:
            receipts.append(json.loads(receipt_path.read_text()))
        except (OSError, ValueError):
            pass
    for key, recipe in RECIPES.items():
        voices = []
        for voice in voice_choices(key):
            choices = []
            for quality in qualities(key, voice['id']):
                variant = selected_recipe({'model': key, 'voice': voice['id'], 'quality': quality['id']})
                state = recipe_status(variant)
                if state['status'] == 'missing' and any(
                    r.get('model') == key and
                    (key != 'piper-lessac' or r.get('voice', recipe['voice']) == voice['id']) and
                    (key not in ('piper-lessac','kitten') or r.get('quality', selected_quality({'model': key})) == quality['id'])
                    for r in receipts):
                    state['status'] = 'upgrade'
                choices.append(quality | state | {'revision': variant['revision']})
            voices.append(voice | {'qualities': choices, 'ready': any(q['ready'] for q in choices)})
        default_quality = selected_quality({'model': key})
        default_state = next(q for v in voices if v['id'] == recipe['voice'] for q in v['qualities'] if q['id'] == default_quality)
        models.append({k: recipe[k] for k in ('label', 'engine', 'revision', 'runtime', 'license', 'source', 'voice')} |
                      {k: default_state[k] for k in ('ready','status','bytes','installed_runtime')} |
                      {'id': key, 'voices': voices, 'quality': default_quality, 'controls': CAPABILITIES[recipe['engine']]})
    return {'ok': True, 'models': models, 'formats': FORMATS, 'active_job': ACTIVE, 'default_output': str(ROOT/'outbox'/'speech.flac')}


def begin(kind, payload):
    global ACTIVE
    if ACTIVE:
        return {'ok': False, 'error': 'A TTS job is already running', 'job': ACTIVE}
    for old in list(TASKS)[:-63]:
        TASKS.pop(old, None)
    token = uuid.uuid4().hex
    TASKS[token] = {'ok': True, 'job': token, 'kind': kind, 'status': 'running', 'message': 'Starting', 'current': 0, 'total': 0, 'started_at': time.time()}
    if kind == 'generate':
        TASKS[token]['model'] = payload['model']
        TASKS[token]['word_count'] = len(payload['text'].split())
    ACTIVE = token
    job_control.register(token, operation='tts_'+kind)
    asyncio.create_task(run(token, kind, payload))
    return {'ok': True, 'job': token}


def job_status(token):
    job = TASKS.get(token, {'ok': False, 'error': 'Unknown TTS job'})
    if job.get('status') == 'running' and job.get('kind') == 'generate' and job.get('current', 0) == 0:
        try:
            phase = (PREVIEW_ROOT/(token+'.phase')).read_text()
            if phase in ('Loading model', 'Synthesizing speech'):
                job['message'] = phase
        except OSError:
            pass
    return job


def progress(token, message, current=0, total=0):
    TASKS[token].update(message=message, current=current, total=total)
    job_control.report_progress(message, phase=TASKS[token]['kind'], current=current, total=total, unit='bytes' if TASKS[token]['kind']=='install' else 'steps', token=token)


async def download(token, payload):
    payload = {'model': payload} if isinstance(payload, str) else payload
    model = payload['model']
    recipe = selected_recipe(payload)
    dest = model_path(recipe)
    staging = MODEL_ROOT / (recipe['revision']+'.'+token+'.partial')
    staging.mkdir(parents=True, exist_ok=False)
    try:
        hashes = {}
        total = sum(f['size'] for f in recipe['files'])
        current = 0
        async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
            for file in recipe['files']:
                digest = hashlib.sha256()
                count = 0
                async with client.stream('GET', file['url']) as response:
                    response.raise_for_status()
                    artifact = staging/file['name']
                    artifact.parent.mkdir(parents=True, exist_ok=True)
                    with artifact.open('wb') as output:
                        async for chunk in response.aiter_bytes(1024*1024):
                            count += len(chunk)
                            if count > file['size']:
                                raise ValueError('Artifact exceeds expected size: '+file['name'])
                            output.write(chunk); digest.update(chunk); current += len(chunk)
                            progress(token, 'Downloading '+file['name'], current, total)
                if count != file['size'] or (file.get('sha256') and digest.hexdigest() != file['sha256']):
                    raise ValueError('Artifact verification failed: '+file['name'])
                if file.get('git_sha1') and artifact_digest(file, artifact.read_bytes()) != file['git_sha1']:
                    raise ValueError('Artifact verification failed: '+file['name'])
                hashes[file['name']] = digest.hexdigest()
        progress(token, 'Installing pinned '+recipe['package']+' '+recipe['runtime'], current, total)
        package = recipe.get('install_url') or recipe['package']+'=='+recipe['runtime']
        uv = shutil.which('uv')
        argv = [uv, 'pip', 'install', '--python', sys.executable, package] if uv else [sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', package]
        code, _, error = await shell.run_command(argv)
        if code:
            raise RuntimeError(error[-2000:])
        progress(token, 'Validating runtime and model pairing', current, total)
        code, _, error = await shell.run_command([sys.executable, str(ROOT/'tools'/'tts_worker.py'), '--engine', recipe['engine'], '--model-dir', str(staging), '--check'])
        if code:
            raise RuntimeError(error[-2000:])
        (staging/'receipt.json').write_text(json.dumps({'model': model, 'revision': recipe['revision'], 'runtime': recipe['runtime'], 'voice': selected_voice(payload), 'quality': selected_quality(payload), 'sha256': hashes, 'installed_at': time.time()}, indent=2))
        if dest.exists():
            dest.rename(MODEL_ROOT/(recipe['revision']+'.previous.'+token))
        staging.rename(dest)
        return {'model': model, 'revision': recipe['revision'], 'voice': selected_voice(payload), 'quality': selected_quality(payload)}
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cleanup_previews():
    for key, value in list(PREVIEWS.items()):
        if time.time()-value['created'] > 3600:
            value['path'].unlink(missing_ok=True); PREVIEWS.pop(key, None)


async def generate(token, payload):
    cleanup_previews()
    recipe = selected_recipe(payload)
    quality = selected_quality(payload)
    controls = validate_controls(recipe['engine'], payload.get('controls'))
    model = next(m for m in catalog()['models'] if m['id']==payload['model'])
    variant = next((q for v in model.get('voices', []) if v['id']==selected_voice(payload) for q in v['qualities'] if q['id']==quality), model)
    if not variant['ready']:
        raise ValueError('Download this model before generating speech')
    voice = selected_voice(payload)
    text = payload['text'].strip()
    if not text or len(text)>10000:
        raise ValueError('Enter 1–10,000 characters of text')
    fmt = payload.get('format', 'flac')
    settings = payload.get('settings', {})
    PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
    source = PREVIEW_ROOT/(token+'.source.wav')
    converted = PREVIEW_ROOT/(token+'.'+FORMATS[fmt]['extension'])
    export_args(source, converted, fmt, settings)  # Validate before inference.
    save = payload.get('save_audio', True)
    destination = None
    if save:
        raw = payload.get('output_path', '').strip() or str(ROOT/'outbox'/'speech.flac')
        destination = Path(raw).expanduser()
        if not destination.is_absolute():
            raise ValueError('Output path must be absolute')
        destination = destination.with_suffix('.'+FORMATS[fmt]['extension'])
        from ..pathutil import unique_output_path
        destination = unique_output_path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        text_path = PREVIEW_ROOT/(token+'.txt')
        text_path.write_text(text)
        from .. import model_hot
        words = len(text.split())
        bucket = tts_timing.key(recipe, voice, quality, controls)
        reused = model_hot.tts_reused(recipe['engine'], model_path(recipe))
        TASKS[token].update(model_label=model.get('label', recipe['label']), word_count=words,
            estimated_s=tts_timing.estimate(bucket, words, reused))
        progress(token, 'Generating speech · model hot' if reused else 'Loading model / generating speech', 0, 2)
        resident_run = model_hot.enabled() and recipe['engine'] != 'dectalk'
        if resident_run:
            metrics = await model_hot.synthesize(recipe['engine'], model_path(recipe), voice, quality, controls, text_path, source)
            code, error = 0, ''
        else:
            code, worker_stdout, error = await shell.run_command([sys.executable, str(ROOT/'tools'/'tts_worker.py'), '--engine', recipe['engine'], '--model-dir', str(model_path(recipe)), '--voice', voice, '--quality', quality, '--controls', json.dumps(controls), '--text-file', str(text_path), '--output', str(source), '--phase-file', str(text_path.with_suffix('.phase'))])
        if code:
            raise RuntimeError(error[-2000:])
        if not resident_run:
            raw_metrics = shell.parse_line(worker_stdout, 'TTS_TIMING:')
            metrics = json.loads(raw_metrics) if raw_metrics else {}
        export_started = time.monotonic()
        progress(token, 'Converting audio to '+fmt.upper(), 1, 2)
        await convert_audio(source, converted, fmt, settings)
        if destination:
            with destination.open('xb') as output, converted.open('rb') as input_file:
                shutil.copyfileobj(input_file, output)
        tts_timing.record(bucket, words, metrics, time.monotonic()-export_started)
        TASKS[token]['timing'] = {**metrics, 'words': words}
        preview = uuid.uuid4().hex
        PREVIEWS[preview] = {'path': converted, 'created': time.time(), 'mime': FORMATS[fmt]['mime']}
        def expire():
            item = PREVIEWS.pop(preview, None)
            if item:
                item['path'].unlink(missing_ok=True)
        asyncio.get_running_loop().call_later(3600, expire)
        progress(token, 'Audio ready', 2, 2)
        return {'preview': '/api/tts/preview/'+preview, 'preview_id': preview, 'output': str(destination) if destination else None, 'format': fmt, 'temporary': not save, 'voice': voice, 'quality': quality, 'revision': recipe['revision'], 'controls': controls, 'model': payload['model'], 'text': text, 'settings': {'channels': settings.get('channels', 1), 'sample_rate': settings.get('sample_rate', 48000 if fmt == 'opus' else 0), **({'bitrate': settings.get('bitrate', 128)} if 'bitrates' in FORMATS[fmt] else {}), **({'sample_bits': settings.get('sample_bits', 16)} if 'sample_bits' in FORMATS[fmt] else {}), **({'compression': settings.get('compression', 5)} if fmt == 'flac' else {})}}
    except Exception:
        converted.unlink(missing_ok=True)
        raise
    finally:
        source.unlink(missing_ok=True)
        (PREVIEW_ROOT/(token+'.txt')).unlink(missing_ok=True)
        (PREVIEW_ROOT/(token+'.phase')).unlink(missing_ok=True)


async def run(token, kind, payload):
    global ACTIVE
    from .. import model_hot
    model_hot.begin()
    try:
        result = await (download(token, payload) if kind=='install' else generate(token, payload))
        if kind == 'install':
            await model_hot.invalidate_tts()
        TASKS[token].update(status='done', result=result, message='Download ready' if kind=='install' else 'Audio ready')
        job_control.finish(token, status='done')
    except Exception as error:
        TASKS[token].update(ok=False, status='failed', error=str(error), message=str(error))
        job_control.finish(token, status='failed', message=str(error))
    finally:
        job_control.unregister(token)
        ACTIVE = None
        await model_hot.finish()
