"""Isolated synthesis worker, optionally resident for repeated requests."""
import argparse
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.audio.tts_controls import validate_controls, dectalk_commands

import os
import time
import traceback
from types import SimpleNamespace

_model = None
_model_key = None
_loads = 0

def execute(a):
    global _model, _model_key, _loads
    def phase(message):
        target = getattr(a, 'phase_file', None)
        if target:
            path = Path(target)
            tmp = path.with_suffix('.tmp')
            tmp.write_text(message)
            tmp.replace(path)
    phase('Loading model')
    started = time.monotonic()
    synthesis_started = started
    reused = _model is not None and _model_key == (a.engine, str(Path(a.model_dir).resolve()))
    key = (a.engine, str(Path(a.model_dir).resolve()))
    def cached(loader):
        global _model, _model_key, _loads
        if _model is None or _model_key != key:
            _model = None
            _model = loader()
            _model_key = key
            _loads += 1
        return _model
    root = Path(a.model_dir)
    controls = validate_controls(a.engine, json.loads(a.controls))
    if a.engine == 'piper':
        from piper import PiperVoice, SynthesisConfig
        import wave
        model = cached(lambda: PiperVoice.load(str(root/'voice.onnx'), use_cuda=False))
        if not a.check:
            phase('Synthesizing speech')
            synthesis_started = time.monotonic()
            with wave.open(a.output, 'wb') as output:
                model.synthesize_wav(Path(a.text_file).read_text(), output, syn_config=SynthesisConfig(
                    length_scale=model.config.length_scale/controls['speed'], noise_scale=controls['noise_scale'],
                    noise_w_scale=controls['noise_w_scale'], volume=controls['volume'], normalize_audio=controls['normalize_audio']))
    elif a.engine == 'kokoro':
        from kokoro_onnx import Kokoro
        import soundfile
        model = cached(lambda: Kokoro(str(root/'kokoro.onnx'), str(root/'voices.bin')))
        if not a.check:
            phase('Synthesizing speech')
            synthesis_started = time.monotonic()
            samples, rate = model.create(Path(a.text_file).read_text(), voice=a.voice or 'af_heart', speed=controls['speed'],
                lang=('en-gb' if (a.voice or '').startswith('b') else 'en-us') if controls['language']=='auto' else controls['language'],
                sentence_pause=controls['sentence_pause'], clause_pause=controls['clause_pause'],
                is_phonemes=controls['is_phonemes'], trim=controls['trim'])
            soundfile.write(a.output, samples, rate)
    elif a.engine == 'supertonic':
        from supertonic import TTS
        import soundfile
        model = cached(lambda: TTS(model='supertonic-3', model_dir=root, auto_download=False,
                    intra_op_num_threads=4, inter_op_num_threads=1))
        if not a.check:
            phase('Synthesizing speech')
            synthesis_started = time.monotonic()
            samples, duration = model.synthesize(Path(a.text_file).read_text(),
                voice_style=model.get_voice_style(a.voice or 'F1'), lang=controls['language'], speed=controls['speed'],
                silence_duration=controls['silence_duration'], max_chunk_length=controls['max_chunk_length'] or None,
                total_steps=controls['total_steps'] or {'low': 5, 'medium': 8, 'high': 12}[a.quality])
            soundfile.write(a.output, samples.reshape(-1), model.sample_rate)
    elif a.engine == 'kitten':
        from kittentts.onnx_model import KittenTTS_1_Onnx
        import soundfile
        config = json.loads((root/'config.json').read_text())
        model = cached(lambda: KittenTTS_1_Onnx(model_path=str(root/config['model_file']),
            voices_path=str(root/config['voices']), speed_priors=config.get('speed_priors', {}),
            voice_aliases=config.get('voice_aliases', {})))
        if not a.check:
            phase('Synthesizing speech')
            synthesis_started = time.monotonic()
            samples = model.generate(Path(a.text_file).read_text(), voice=a.voice or 'Bella', speed=controls['speed'], clean_text=controls['clean_text'])
            soundfile.write(a.output, samples, 24000)
    elif a.engine == 'dectalk':
        import asyncio
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app import shell
        import shutil
        say_bin = shutil.which('dectalk-say') or '/home/m/.local/share/dectalk/say'
        if not Path(say_bin).exists():
            raise RuntimeError('DECtalk say binary not found')
        if not a.check:
            phase('Synthesizing speech')
            synthesis_started = time.monotonic()
            text = Path(a.text_file).read_text().strip()
            voices = {'paul':'p', 'betty':'b', 'harry':'h', 'dennis':'d', 'frank':'f', 'rita':'r', 'ursula':'u', 'wendy':'w', 'kit':'k'}
            code = voices[a.voice or 'paul']
            cmd = [str(say_bin), '-fo', str(a.output), '-a', f'[:n{code}]'+dectalk_commands(controls)+' '+text]
            returncode, _, error = asyncio.run(shell.run_command(cmd))
            if returncode != 0 and not Path(a.output).is_file():
                raise RuntimeError(f'DECtalk failed: {error}')

    return {'load_s': synthesis_started-started, 'inference_s': time.monotonic()-synthesis_started, 'reused': reused}


def serve(directory):
    inbox = Path(directory).resolve()
    parent = os.getppid()
    while os.getppid() == parent and not (inbox/'stop').exists():
        requests = sorted(inbox.glob('*.request.json'))
        if not requests:
            time.sleep(.05)
            continue
        for path in requests:
            try:
                metrics = execute(SimpleNamespace(**json.loads(path.read_text())))
                result = {'ok': True, 'pid': os.getpid(), 'loads': _loads, **metrics}
            except Exception as error:
                traceback.print_exc()
                result = {'ok': False, 'error': str(error)}
            response = path.with_name(path.name.replace('.request.json', '.response.json'))
            staging = response.with_suffix('.tmp')
            staging.write_text(json.dumps(result))
            staging.replace(response)
            path.unlink(missing_ok=True)

p = argparse.ArgumentParser()
p.add_argument('--engine', choices=['piper', 'kokoro', 'dectalk', 'supertonic', 'kitten'])
p.add_argument('--model-dir')
p.add_argument('--voice')
p.add_argument('--quality', default='medium')
p.add_argument('--controls', default='{}')
p.add_argument('--check', action='store_true')
p.add_argument('--text-file')
p.add_argument('--output')
p.add_argument('--phase-file')
p.add_argument('--serve')
a = p.parse_args()
if a.serve:
    serve(a.serve)
else:
    if not a.engine or not a.model_dir:
        p.error('--engine and --model-dir are required without --serve')
    metrics = execute(a)
    print('TTS_TIMING: '+json.dumps(metrics))
    print('Runtime/model pairing OK' if a.check else 'Audio generated')
