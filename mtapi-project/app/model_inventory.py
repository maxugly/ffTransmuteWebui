"""Read-only model artifact inventory. Never imports or loads a neural runtime."""
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOME = Path.home()
TABS = {
    'tts': ('TTS', True), 'deepdream': ('DeepDream', True),
    'styletransfer': ('Style Transfer', True), 'fastsam': ('Vision / FastSAM', True),
    'demucs': ('Stems / Demucs', True), 'erase': ('Erase / LaMa', True),
    'withoutbg': ('WithoutBG', True), 'music': ('Music / ACE-Step', False),
    'txt2img': ('Txt2Img', False), 'img2img': ('Img2Img', False),
    'qr_art': ('QR Art', False), 'rife': ('RIFE', False),
    'riferecohere': ('RIFE Recohere', False), 'upscale': ('Upscale', False),
    'facemorph': ('Face Morph', False), 'speedchange': ('Speed / RIFE', False),
    'sequence': ('Sequence / RIFE', False), 'airapper': ('AI Rapper / ACE-Step', False),
    'imagesort': ('Image Sort / RIFE', False),
}
_SIZE_CACHE = {}
WEIGHT_SUFFIXES = {'.onnx', '.bin', '.xml', '.pt', '.pth', '.h5', '.pb', '.index', '.safetensors', '.dat', '.param', '.npy'}


def disk_info(paths):
    """Logical artifact bytes, deduplicated by inode (HF symlinks / hardlinks)."""
    paths = tuple(str(Path(p).expanduser().absolute()) for p in paths)
    now = time.monotonic()
    cached = _SIZE_CACHE.get(paths)
    if cached and now - cached[0] < 5:
        return dict(cached[1])
    seen, total, count = set(), 0, 0
    for raw in paths:
        root = Path(raw)
        files = root.rglob('*') if root.is_dir() else [root]
        for path in files:
            if path.suffix.lower() not in WEIGHT_SUFFIXES and '.data-' not in path.name:
                continue
            try:
                stat = path.stat()
                key = (stat.st_dev, stat.st_ino)
                if path.is_file() and key not in seen:
                    seen.add(key)
                    total += stat.st_size
                    count += 1
            except OSError:
                continue
    result = {'disk_bytes': total if count else None, 'files': count, 'paths': list(paths)}
    if len(_SIZE_CACHE) > 128:
        _SIZE_CACHE.clear()
    _SIZE_CACHE[paths] = (now, result)
    return dict(result)


def hf_snapshot(model):
    if not model or '..' in model.split('/'):
        return []
    hub = Path(os.environ.get('HF_HUB_CACHE', str(Path(os.environ.get('HF_HOME', HOME/'.cache/huggingface'))/'hub')))
    repo = hub / ('models--' + model.replace('/', '--'))
    try:
        revision = (repo/'refs'/'main').read_text().strip()
        return [repo/'snapshots'/revision]
    except OSError:
        snapshots = sorted((repo/'snapshots').glob('*'), key=lambda p: p.stat().st_mtime)
        return snapshots[-1:]


def selection(tab, model='', engine='', voice='', quality='', auxiliary='', lora=''):
    """Resolve artifacts for the UI selection, separately from resident models."""
    if tab == 'airapper': tab = 'music'
    paths, label = [], model or TABS.get(tab, (tab, False))[0]
    if tab == 'tts':
        from .audio import tts
        model = model or 'piper-lessac'
        if model in tts.RECIPES:
            payload = {'model': model}
            if voice: payload['voice'] = voice
            if quality: payload['quality'] = quality
            recipe = tts.selected_recipe(payload)
            label = recipe['label']
            paths = [tts.model_path(recipe)/f['name'] for f in recipe['files']]
            if recipe['engine'] == 'dectalk':
                return {'model': model, 'label': label, 'retention_supported': False, 'disk_bytes': 0, 'files': 0, 'paths': [], 'native': True}
    elif tab == 'deepdream':
        if engine.startswith('gpu'):
            from importlib import import_module
            suffix = {'gpu_v2': '_v2', 'gpu_v3': '_v3'}.get(engine, '')
            module = import_module('.operations.deepdream_ov_engine'+suffix, 'app')
            paths = [module.resolve_artifacts_dir()] if module.resolve_artifacts_dir() else []
            label = 'InceptionV3 · '+engine
        else:
            name = model or 'inception_v3'
            paths = list((Path(os.environ.get('KERAS_HOME', HOME/'.keras'))/'models').glob(name+'*notop.h5'))
    elif tab == 'styletransfer':
        if engine == 'gpu':
            from .operations import styletransfer_ov_engine as module
            directory = module.resolve_artifacts_dir()
            paths = [directory] if directory else []
        else:
            # TF-Hub's descriptor identifies the actual module rather than summing unrelated graphs.
            cache = Path(os.environ.get('TFHUB_CACHE_DIR', HOME/'.cache/tfhub_modules'))
            for descriptor in cache.glob('*.descriptor.txt'):
                try:
                    if 'arbitrary-image-stylization' in descriptor.read_text():
                        paths.append(cache/descriptor.name.removesuffix('.descriptor.txt'))
                except OSError:
                    pass
            label = 'Magenta arbitrary image stylization'
    elif tab == 'fastsam':
        name = model or 'FastSAM-s'
        for base in (ROOT, ROOT.parent):
            directory = base/(name+'_openvino_model')
            if directory.exists():
                paths = [directory]
                break
        if not paths:
            paths = [ROOT/(name+'.pt')]
    elif tab == 'erase':
        from .filters.erase import erase_model_dir, ir_path_for
        xml = ir_path_for(erase_model_dir())
        paths, label = [xml, xml.with_suffix('.bin')], 'LaMa'
    elif tab == 'demucs':
        from .operations import demucs_ov_engine as module
        name = model or 'htdemucs'
        if name in module.MODEL_SPECS:
            directory = module.resolve_artifacts_dir(name)
            if directory:
                paths = [directory/f for f in module.MODEL_SPECS[name]['irs']]
                paths += [p.with_suffix('.bin') for p in paths]
    elif tab == 'withoutbg':
        if engine == 'api':
            return {'model': 'cloud', 'label': 'WithoutBG cloud API', 'retention_supported': False, 'disk_bytes': None, 'files': 0, 'paths': [], 'remote': True}
        paths, label = hf_snapshot('withoutbg/withoutbg-openweights-onnx'), 'WithoutBG open weights'
    elif tab == 'music':
        from .operations import music_ov_engine as module
        name = model or 'acestep-v15-base'
        if name in module.MUSIC_MODELS and module.MUSIC_MODELS[name]['enabled']:
            paths = [module.SOURCE_DIR/p for p in module.manifest_for(name) if p.endswith(('.xml','.bin'))]
            pair = module.all_lora_pairs().get(lora) if lora else None
            if pair and pair['model'] == name:
                xml = module.SOURCE_DIR/pair['dit_dir']/pair['dit_file']
                paths[:2] = [xml, xml.with_suffix('.bin')]
                label = pair['label']
    elif tab in ('txt2img','img2img','qr_art'):
        name = model or 'rupeshs/sd-turbo-openvino'
        paths = hf_snapshot(name)
    elif tab in ('rife','riferecohere','speedchange','sequence','imagesort'):
        name = model or 'rife-v4.6'
        import shutil
        binary = shutil.which('rife-ncnn-vulkan')
        bases = [Path('/usr/share/rife-ncnn-vulkan'), HOME/'.local/share/rife-ncnn-vulkan', ROOT/'bin', ROOT]
        if binary: bases.insert(0, Path(binary).resolve().parent)
        paths = next(([b/name] for b in bases if (b/name).is_dir()), [])
    elif tab == 'upscale':
        from .filters.upscale import resolve_upscale_models
        import shutil
        name = engine or 'realesrgan'
        binary = shutil.which(name+'-ncnn-vulkan')
        if binary:
            directory = Path(resolve_upscale_models(name, binary)).expanduser().absolute()
            matches = list(directory.glob((model or 'realesr-animevideov3')+'*')) if name == 'realesrgan' else []
            paths = matches or [directory]
    elif tab == 'facemorph':
        paths = [Path(os.environ.get('FACEMORPH_ROOT', HOME/'snc/cod/facemorph'))/'code/utils/shape_predictor_68_face_landmarks.dat']
        label = 'dlib · 68 face landmarks'
    if tab == 'riferecohere' and auxiliary:
        paths += hf_snapshot(auxiliary)
        label += ' + '+auxiliary
    return {'model': model, 'label': label, 'retention_supported': TABS.get(tab, ('', False))[1], **disk_info(paths)}
