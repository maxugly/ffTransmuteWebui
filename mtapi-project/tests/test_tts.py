"""Audio export validation, atomic install failure, and temporary TTS lifecycle."""
import asyncio
import json
import wave
from pathlib import Path

import pytest
from app.audio import tts
from app.audio.export import export_args, convert_audio


def wav_file(path):
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(1); f.setsampwidth(2); f.setframerate(22050)
        f.writeframes(b'\0\0' * 2205)


def test_codec_specific_args_and_invalid_settings(tmp_path):
    argv = export_args(tmp_path/'in.wav', tmp_path/'out.flac', 'flac', {'channels': 2, 'sample_bits': 24, 'compression': 12})
    assert '-n' in argv and '-y' not in argv
    assert argv[argv.index('-ac')+1] == '2'
    assert argv[argv.index('-sample_fmt')+1] == 's32'
    for fmt, settings in [('flac', {'bitrate':128}), ('mp3', {'sample_bits':24}), ('opus', {'sample_rate':44100}), ('wav', {'channels':3}), ('flac', {'compression':13}), ('mp3', {'extra':'x'})]:
        with pytest.raises(ValueError):
            export_args(tmp_path/'in.wav', tmp_path/'out', fmt, settings)


@pytest.mark.parametrize('fmt', ['wav', 'flac', 'mp3', 'opus', 'aac'])
def test_real_ffmpeg_conversion(tmp_path, fmt):
    source = tmp_path/'source.wav'; wav_file(source)
    destination = tmp_path/('export.'+tts.FORMATS[fmt]['extension'])
    asyncio.run(convert_audio(source, destination, fmt))
    assert destination.is_file() and destination.stat().st_size>50
    with pytest.raises(RuntimeError):
        asyncio.run(convert_audio(source, destination, fmt))


def test_saved_and_temporary_generation_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, 'PREVIEW_ROOT', tmp_path/'previews')
    monkeypatch.setattr(tts, 'catalog', lambda: {'models':[{'id':'piper-lessac', 'ready':True}]})
    async def worker(argv):
        wav_file(Path(argv[argv.index('--output')+1])); return 0, '', ''
    monkeypatch.setattr(tts.shell, 'run_command', worker)
    async def convert(source, dest, fmt, settings):
        dest.write_bytes(source.read_bytes())
    monkeypatch.setattr(tts, 'convert_audio', convert)
    for save in [True, False]:
        token = 'saved' if save else 'temporary'
        tts.TASKS[token]={'kind':'generate'}
        result=asyncio.run(tts.generate(token, {'model':'piper-lessac','text':'hello','format':'wav','save_audio':save,'output_path':str(tmp_path/'speech.wav')}))
        assert bool(result['output']) is save
        assert not (tts.PREVIEW_ROOT/(token+'.source.wav')).exists()
        assert not (tts.PREVIEW_ROOT/(token+'.txt')).exists()
        preview=tts.PREVIEWS[result['preview_id']]
        preview['created']=0
        tts.cleanup_previews()
        assert not preview['path'].exists()
        if save: assert Path(result['output']).exists()


def test_worker_failure_removes_intermediates(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, 'PREVIEW_ROOT', tmp_path)
    monkeypatch.setattr(tts, 'catalog', lambda: {'models':[{'id':'piper-lessac','ready':True}]})
    async def worker(argv): return 1,'','intentional failure'
    monkeypatch.setattr(tts.shell,'run_command',worker)
    tts.TASKS['failure']={'kind':'generate'}
    with pytest.raises(RuntimeError, match='intentional failure'):
        asyncio.run(tts.generate('failure',{'model':'piper-lessac','text':'hi','format':'wav','save_audio':False}))
    assert not list(tmp_path.glob('failure.*'))


def test_busy_job_refuses_duplicate_start(monkeypatch):
    monkeypatch.setattr(tts,'ACTIVE','busy')
    assert tts.begin('install',{'model':'piper-lessac'}) == {'ok':False,'error':'A TTS job is already running','job':'busy'}


def test_readiness_requires_matching_runtime_and_all_artifacts(tmp_path, monkeypatch):
    monkeypatch.setattr(tts,'MODEL_ROOT',tmp_path)
    recipe=tts.RECIPES['piper-lessac']; root=tts.model_path(recipe);root.mkdir()
    (root/'receipt.json').write_text(json.dumps({'revision':recipe['revision'],'model':'piper-lessac'}))
    monkeypatch.setattr(tts.importlib.metadata,'version',lambda _:recipe['runtime'])
    assert not tts.catalog()['models'][0]['ready']


def test_bad_download_never_activates_or_installs_runtime(tmp_path, monkeypatch):
    monkeypatch.setattr(tts, 'MODEL_ROOT', tmp_path)
    recipe = dict(tts.RECIPES['piper-lessac'])
    recipe['files']=[{'name':'voice.onnx','url':'https://example.test/model','size':3,'sha256':'wrong'}]
    monkeypatch.setitem(tts.RECIPES,'piper-lessac',recipe)
    dest=tts.model_path(recipe);dest.mkdir();(dest/'receipt.json').write_text('old receipt')
    class Response:
        def raise_for_status(self): pass
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        async def aiter_bytes(self, size): yield b'abc'
    class Client:
        def __init__(self,**kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self,*args): pass
        def stream(self,*args): return Response()
    monkeypatch.setattr(tts.httpx,'AsyncClient',Client)
    async def forbidden(argv): raise AssertionError('Must not install after hash failure')
    monkeypatch.setattr(tts.shell,'run_command',forbidden)
    tts.TASKS['bad']={'kind':'install'}
    with pytest.raises(ValueError,match='Artifact verification failed'):
        asyncio.run(tts.download('bad','piper-lessac'))
    assert (dest/'receipt.json').read_text()=='old receipt'
    assert not list(tmp_path.glob('*.partial'))


def test_route_input_errors_remain_operational_failures(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from app.routes import tts as routes
    monkeypatch.setattr(tts,'PREVIEW_ROOT',tmp_path)
    app=FastAPI();routes.register(app)
    endpoint=next(r.endpoint for r in app.routes if r.path=='/api/tts/generate')
    for payload in [{'model':{}}, {'model':'piper-lessac','text':None}, {'model':'piper-lessac','text':'hi','format':{}}, {'model':'piper-lessac','text':'hi','save_audio':'false'}]:
        assert asyncio.run(endpoint(payload))['ok'] is False


def test_artifact_corruption_invalidates_readiness_cache(tmp_path):
    import hashlib
    path=tmp_path/'voice.onnx';path.write_bytes(b'abc')
    recipe={'revision':'v1','files':[{'name':'voice.onnx','size':3,'sha256':hashlib.sha256(b'abc').hexdigest()}]}
    receipt={'revision':'v1'}
    assert tts.artifacts_ready(recipe,tmp_path,receipt)
    path.write_bytes(b'xyz')
    assert not tts.artifacts_ready(recipe,tmp_path,receipt)


def test_voice_options_and_cross_model_rejection(tmp_path, monkeypatch):
    import zipfile
    monkeypatch.setattr(tts, 'MODEL_ROOT', tmp_path)
    path=tts.model_path(tts.RECIPES['kokoro']);path.mkdir()
    with zipfile.ZipFile(path/'voices.bin','w') as bank:
        for name in ['af_heart.npy','af_bella.npy','bm_george.npy','jf_alpha.npy']:
            bank.writestr(name,b'fixture')
    choices=tts.voice_choices('kokoro')
    assert {v['id'] for v in choices}=={'af_heart','af_bella','bm_george'}
    assert tts.selected_voice({'model':'kokoro','voice':'bm_george'})=='bm_george'
    assert len(tts.voice_choices('dectalk-paul'))==9
    for model,voice in [('piper-lessac','af_heart'),('kokoro','paul'),('dectalk-paul','invalid'),('kokoro',{})]:
        with pytest.raises(ValueError,match='available voice'):
            tts.selected_voice({'model':model,'voice':voice})


def test_selected_voice_reaches_worker(tmp_path,monkeypatch):
    monkeypatch.setattr(tts,'PREVIEW_ROOT',tmp_path)
    monkeypatch.setattr(tts,'catalog',lambda:{'models':[{'id':'dectalk-paul','ready':True}]})
    calls=[]
    async def worker(argv):
        calls.append(argv);wav_file(Path(argv[argv.index('--output')+1]));return 0,'',''
    async def convert(source,dest,fmt,settings):dest.write_bytes(source.read_bytes())
    monkeypatch.setattr(tts.shell,'run_command',worker)
    monkeypatch.setattr(tts,'convert_audio',convert)
    tts.TASKS['betty']={'kind':'generate'}
    result=asyncio.run(tts.generate('betty',{'model':'dectalk-paul','voice':'betty','text':'hello','format':'wav','save_audio':False}))
    assert calls[0][calls[0].index('--voice')+1]=='betty'
    assert result['voice']=='betty'
    tts.PREVIEWS[result['preview_id']]['created']=0;tts.cleanup_previews()


def test_piper_library_quality_and_recipe_routing():
    voices=tts.voice_choices('piper-lessac')
    assert len(voices)==23
    assert {q['id'] for q in tts.qualities('piper-lessac','lessac')}=={'low','medium','high'}
    assert tts.selected_recipe({'model':'piper-lessac'}) is tts.RECIPES['piper-lessac']
    high=tts.selected_recipe({'model':'piper-lessac','voice':'lessac','quality':'high'})
    low=tts.selected_recipe({'model':'piper-lessac','voice':'lessac','quality':'low'})
    assert high['revision']!=low['revision']
    assert high['files'][0]['url']!=low['files'][0]['url']
    with pytest.raises(ValueError,match='available quality'):
        tts.selected_recipe({'model':'piper-lessac','voice':'en_US-amy','quality':'high'})


def test_modern_profiles_route_exact_weights_and_steps():
    assert len(tts.voice_choices('supertonic-3'))==10
    assert len(tts.voice_choices('kitten'))==8
    small=tts.selected_recipe({'model':'kitten','quality':'nano'})
    large=tts.selected_recipe({'model':'kitten','quality':'mini'})
    assert small['revision']!=large['revision']
    assert small['files'][1]['url']!=large['files'][1]['url']
    assert tts.selected_quality({'model':'kitten'})=='mini'
    assert tts.selected_recipe({'model':'supertonic-3','quality':'low'}) is tts.selected_recipe({'model':'supertonic-3','quality':'high'})
    assert [q['steps'] for q in tts.qualities('supertonic-3','F1')]==[5,8,12]


def test_git_blob_verification_detects_config_change(tmp_path):
    import hashlib
    path=tmp_path/'config.json';path.write_bytes(b'abc')
    recipe={'revision':'v1','files':[{'name':'config.json','size':3,'git_sha1':hashlib.sha1(b'blob 3\0abc').hexdigest()}]}
    assert tts.artifacts_ready(recipe,tmp_path,{'revision':'v1'})
    path.write_bytes(b'xyz')
    assert not tts.artifacts_ready(recipe,tmp_path,{'revision':'v1'})


def test_generation_requires_selected_checkpoint_not_family_default(monkeypatch):
    monkeypatch.setattr(tts,'catalog',lambda:{'models':[{'id':'piper-lessac','ready':True,'voices':[{'id':'lessac','qualities':[{'id':'high','ready':False}]}]}]})
    with pytest.raises(ValueError,match='Download this model'):
        asyncio.run(tts.generate('uninstalled',{'model':'piper-lessac','voice':'lessac','quality':'high','text':'hi','save_audio':False}))


def test_upgrade_status_does_not_mark_other_piper_voices_as_updates(tmp_path,monkeypatch):
    monkeypatch.setattr(tts,'MODEL_ROOT',tmp_path)
    older=tmp_path/'old-version';older.mkdir()
    (older/'receipt.json').write_text(json.dumps({'model':'piper-lessac','voice':'lessac','quality':'high','revision':'old'}))
    piper=tts.catalog()['models'][0]
    lessac=next(v for v in piper['voices'] if v['id']=='lessac')
    assert next(q for q in lessac['qualities'] if q['id']=='high')['status']=='upgrade'
    assert next(q for q in lessac['qualities'] if q['id']=='low')['status']=='missing'
    amy=next(v for v in piper['voices'] if v['id']=='en_US-amy')
    assert all(q['status']=='missing' for q in amy['qualities'])


@pytest.mark.parametrize('engine,values',[
    ('piper',{'emotion':'happy'}),('kitten',{'noise_scale':.5}),('kokoro',{'speed':3}),
    ('piper',{'speed':True}),('supertonic',{'speed':float('nan')}),
    ('supertonic',{'total_steps':3.5}),('dectalk',{'dv_ap':40}),
    ('dectalk',{'punctuation':'] malicious command ['}),('kitten',{'clean_text':'false'}),
])
def test_native_controls_reject_unsupported_and_invalid_values(engine,values):
    from app.audio.tts_controls import validate_controls
    with pytest.raises(ValueError):validate_controls(engine,values)


def test_native_controls_keep_voice_defaults_and_apply_mode_dependencies():
    from app.audio.tts_controls import validate_controls,dectalk_commands
    piper=validate_controls('piper',{'speed':1.5,'volume':.4})
    assert piper['noise_scale'] is None and piper['noise_w_scale'] is None
    with pytest.raises(ValueError,match='Unsupported controls'):
        validate_controls('kokoro',{'continuous':True})
    dt=validate_controls('dectalk',{'rate':250,'dv_ap':170,'dv_pr':0})
    commands=dectalk_commands(dt)
    assert '[:rate 250]' in commands and 'ap 170' in commands and 'pr 0' in commands
    assert 'None' not in commands and 'auto' not in commands
    with pytest.raises(ValueError,match='300 Hz'):
        validate_controls('dectalk',{'dv_f4':4000,'dv_f5':4100})


def test_controls_snapshot_reaches_inference_worker(tmp_path,monkeypatch):
    monkeypatch.setattr(tts,'PREVIEW_ROOT',tmp_path)
    monkeypatch.setattr(tts,'catalog',lambda:{'models':[{'id':'piper-lessac','ready':True}]})
    calls=[]
    async def worker(argv):
        calls.append(argv);wav_file(Path(argv[argv.index('--output')+1]));return 0,'',''
    async def convert(source,dest,fmt,settings):dest.write_bytes(source.read_bytes())
    monkeypatch.setattr(tts.shell,'run_command',worker)
    monkeypatch.setattr(tts,'convert_audio',convert)
    tts.TASKS['knobs']={'kind':'generate'}
    result=asyncio.run(tts.generate('knobs',{'model':'piper-lessac','text':'hi','format':'wav','save_audio':False,'controls':{'speed':1.6,'volume':.3,'normalize_audio':False}}))
    settings=json.loads(calls[0][calls[0].index('--controls')+1])
    assert result['model']=='piper-lessac' and result['text']=='hi'
    assert result['settings']=={'channels':1,'sample_rate':0,'sample_bits':16}
    assert settings==result['controls']
    assert settings['speed']==1.6 and settings['volume']==.3 and settings['normalize_audio'] is False
    tts.PREVIEWS[result['preview_id']]['created']=0;tts.cleanup_previews()


def test_controls_route_failure_does_not_start_a_job(tmp_path,monkeypatch):
    from fastapi import FastAPI
    from app.routes import tts as routes
    monkeypatch.setattr(tts,'PREVIEW_ROOT',tmp_path)
    app=FastAPI();routes.register(app)
    endpoint=next(r.endpoint for r in app.routes if r.path=='/api/tts/generate')
    monkeypatch.setattr(tts,'begin',lambda *_:pytest.fail('Invalid model controls must not start inference'))
    response=asyncio.run(endpoint({'model':'kitten','text':'hi','controls':{'emotion':'sad'}}))
    assert response['ok'] is False and 'Unsupported controls' in response['error']



def test_capabilities_exclude_unavailable_features_of_pinned_models():
    from app.audio.tts_controls import CAPABILITIES
    assert 'continuous' not in {c['id'] for c in CAPABILITIES['kokoro']}
    assert not {'volume','dv_f8','dv_ago','dv_agvo','dv_aguo','dv_chink','dv_oq'} & {c['id'] for c in CAPABILITIES['dectalk']}
    assert all('emotion' not in {c['id'] for c in fields} for fields in CAPABILITIES.values())
