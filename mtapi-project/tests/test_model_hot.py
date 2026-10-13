import asyncio
import sys
from types import SimpleNamespace

from app import model_hot
from app.audio import tts_timing
from app.media import performance


def test_policy_defaults_and_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(performance, 'SETTINGS_PATH', tmp_path/'settings.json')
    monkeypatch.setattr(performance, '_settings_cache', None)
    monkeypatch.setattr(model_hot, 'ACTIVE', 0)
    async def release(tool=None): pass
    monkeypatch.setattr(model_hot, 'release', release)
    assert not model_hot.enabled('tts')
    async def scenario():
        result = await model_hot.configure('tts', True)
        assert result['policies']['tts'] is True
        assert result['policies']['deepdream'] is False
        await model_hot.configure('deepdream', True)
        await model_hot.configure('tts', False)
    asyncio.run(scenario())
    assert not model_hot.enabled('tts')
    assert model_hot.enabled('deepdream')
    assert 'keep_models_hot' not in performance.load_settings()


def test_legacy_global_preference_is_not_promoted():
    settings = performance._normalize_settings({'keep_models_hot': True, 'warm_models': {'deepdream': True}})
    assert settings['warm_models']['deepdream'] is True
    assert settings['warm_models']['tts'] is False
    assert 'keep_models_hot' not in settings


def test_release_deferred_and_scoped(monkeypatch):
    monkeypatch.setattr(model_hot, 'ACTIVE', 0)
    monkeypatch.setattr(model_hot, '_ACTIVE_TOOLS', __import__('collections').Counter())
    monkeypatch.setattr(model_hot, 'enabled', lambda tool: tool != 'deepdream')
    cache = {'model': object()}
    other = {'other': object()}
    monkeypatch.setitem(sys.modules, 'app.operations.deepdream.models', SimpleNamespace(_base_model_cache=cache))
    monkeypatch.setitem(sys.modules, 'app.filters.fastsam', SimpleNamespace(_runtime_model_cache=other))
    monkeypatch.setattr(model_hot, 'CACHES', {
        'app.operations.deepdream.models': (None, '_base_model_cache'),
        'app.filters.fastsam': (None, '_runtime_model_cache')})
    async def scenario():
        await model_hot.begin('deepdream', 'test-job')
        await model_hot.release('deepdream')
        assert cache and other
        assert 'deepdream' in model_hot.status()['release_pending']
        await model_hot.finish('deepdream', 'test-job')
        assert cache == {}
        assert other
    asyncio.run(scenario())


def test_native_release_only_touches_loaded_caches(monkeypatch):
    cache={'checkpoint': object()}
    fake=SimpleNamespace(_runtime_model_cache=cache)
    monkeypatch.setitem(sys.modules,'app.filters.fastsam',fake)
    monkeypatch.setattr(model_hot,'CACHES',{'app.filters.fastsam':(None,'_runtime_model_cache'), 'missing.neural.library':(None,'_model')})
    model_hot._clear_native()
    assert cache == {}
    assert 'missing.neural.library' not in sys.modules


def test_loading_loaded_failed_and_finished(monkeypatch):
    monkeypatch.setattr(model_hot, 'CACHES', {})
    monkeypatch.setattr(model_hot, '_OBSERVED', {})
    monkeypatch.setattr(model_hot, 'ACTIVE', 0)
    monkeypatch.setattr(model_hot, 'enabled', lambda tool: True)
    async def scenario():
        await model_hot.begin('fastsam', 'load-test')
        with model_hot.loading('fastsam', 'FastSAM-s'):
            assert model_hot.status()['loading'][0]['model'] == 'FastSAM-s'
            assert not model_hot.status()['resident']
        assert model_hot.status()['resident'][0]['tool'] == 'fastsam'
        await model_hot.finish('fastsam', 'load-test')
        assert not model_hot.status()['resident']
        try:
            with model_hot.loading('fastsam', 'broken'):
                raise RuntimeError('load failed')
        except RuntimeError:
            pass
        assert not model_hot.status()['loading']
    asyncio.run(scenario())


def test_status_reads_never_load_or_release(monkeypatch):
    cache = {'checkpoint': object()}
    monkeypatch.setattr(model_hot, '_OBSERVED', {})
    monkeypatch.setattr(model_hot, 'CACHES', {'app.filters.fastsam': (None, '_runtime_model_cache')})
    monkeypatch.setitem(sys.modules, 'app.filters.fastsam', SimpleNamespace(_runtime_model_cache=cache))
    for _ in range(10):
        result = model_hot.status()
        assert result['resident'][0]['tool'] == 'fastsam'
    assert cache


def test_disk_size_counts_actual_weights_once(tmp_path):
    from app.model_inventory import disk_info
    model = tmp_path/'model'
    model.mkdir()
    (model/'weights.bin').write_bytes(b'x'*1234)
    (model/'notes.txt').write_text('not model weights')
    (model/'alias.bin').symlink_to(model/'weights.bin')
    info = disk_info([model, model/'weights.bin'])
    assert info['disk_bytes'] == 1234
    assert info['files'] == 1
    assert disk_info([tmp_path/'missing'])['disk_bytes'] is None


def test_timing_separates_load_cost_from_word_cost(tmp_path,monkeypatch):
    monkeypatch.setattr(tts_timing,'PATH',tmp_path/'timings.json')
    assert tts_timing.estimate('model',100,False) is None
    tts_timing.record('model',10,{'load_s':5,'inference_s':2,'reused':False},1)
    assert tts_timing.estimate('model',100,False)==26
    assert tts_timing.estimate('model',100,True)==21
    tts_timing.record('model',20,{'load_s':0,'inference_s':4,'reused':True},1)
    assert tts_timing.estimate('model',100,False)==26
    assert tts_timing.estimate('different-model',100,False) is None
    assert tts_timing.key({'revision':'v1'},'a','low',{'speed':1}) != tts_timing.key({'revision':'v1'},'a','low',{'speed':2})


def test_timing_handles_bad_history_and_bounds_samples(tmp_path,monkeypatch):
    path=tmp_path/'timings.json';monkeypatch.setattr(tts_timing,'PATH',path)
    path.write_text('{"bad": [{"words": 10}], "wrong": false}')
    assert tts_timing.estimate('bad',10,False) is None
    for _ in range(30):tts_timing.record('model',10,{'load_s':1,'inference_s':1,'reused':True},.1)
    assert len(tts_timing.history()['model'])==24
    assert tts_timing.estimate('model',10,False) is None
    assert tts_timing.estimate('model',10,True)==1.1


def test_operation_uses_its_own_tool_policy(monkeypatch):
    from pydantic import BaseModel
    from app import op_runner, media
    from app.contract import OperationSpec, OperationResult
    class Params(BaseModel):
        keep_model_warm: bool = False
    monkeypatch.setattr(model_hot, 'ACTIVE', 0)
    monkeypatch.setattr(model_hot, 'enabled', lambda tool: tool == 'deepdream')
    observed = []
    async def handler(params):
        observed.append((params.keep_model_warm, model_hot.ACTIVE))
        return OperationResult(ok=True, operation='test')
    async def no_record(*args, **kwargs): pass
    async def release(tool=None): pass
    monkeypatch.setattr(media, 'record_operation', no_record)
    monkeypatch.setattr(model_hot, 'release', release)
    async def scenario():
        for tool in ('deepdream', 'fastsam'):
            spec = OperationSpec(id=tool, summary='test', description='test', params_model=Params, handler=handler)
            result = await op_runner.run_registered_op(spec, Params(keep_model_warm=tool != 'deepdream'), token='policy-'+tool)
            assert result.ok and model_hot.ACTIVE == 0
    asyncio.run(scenario())
    assert observed == [(True, 1), (False, 1)]


def test_tool_api_rejects_global_policy_and_one_shot():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.routes import meta
    app = FastAPI()
    meta.register(app, folder_watcher=None, job_control=None, check_tools=None, REGISTRY={})
    client = TestClient(app)
    for body in ({'enabled': True}, {'tool': 'music', 'enabled': True}, {'tool': 'tts', 'enabled': 'yes'}):
        result = client.post('/api/models/hot', json=body)
        assert result.status_code == 200
        assert result.json()['ok'] is False


def test_thread_loading_keeps_job_and_consuming_tab(monkeypatch):
    monkeypatch.setattr(model_hot, '_OBSERVED', {})
    monkeypatch.setattr(model_hot, 'CACHES', {})
    monkeypatch.setattr(model_hot, 'ACTIVE', 0)
    monkeypatch.setattr(model_hot, 'enabled', lambda tool: True)
    async def scenario():
        await model_hot.begin('speedchange', 'thread-load')
        def loader():
            with model_hot.loading('rife', 'rife-v4.6'):
                pass
        await asyncio.to_thread(loader)
        entry = next(iter(model_hot._OBSERVED.values()))
        assert entry['token'] == 'thread-load'
        assert set(entry['tabs']) == {'rife', 'speedchange'}
        await model_hot.finish('speedchange', 'thread-load')
        assert not model_hot._OBSERVED
    asyncio.run(scenario())


def test_deepdream_versions_and_withoutbg_are_visible(monkeypatch):
    monkeypatch.setattr(model_hot, '_OBSERVED', {})
    names = ('app.operations.deepdream_ov_engine_v2', 'app.operations.deepdream_ov_engine_v3')
    for name in names:
        monkeypatch.setitem(sys.modules, name, SimpleNamespace(_compiled={'cpu': object()}, clear_cache=lambda: None))
    monkeypatch.setitem(sys.modules, 'app.operations.withoutbg_engine', SimpleNamespace(_local_model=object()))
    result = model_hot.status()
    assert sum(r['tool'] == 'deepdream' for r in result['resident']) >= 2
    assert any(r['tool'] == 'withoutbg' for r in result['resident'])


def test_fastsam_lazy_load_status_and_cache_hit(monkeypatch):
    from app.filters.fastsam import predict_runtime
    monkeypatch.setattr(model_hot, '_OBSERVED', {})
    class Model:
        predictor = None
        def __call__(self, image, **kwargs):
            assert bool(model_hot.status()['loading']) == (self.predictor is None)
            self.predictor = object()
            return ['mask']
    model = Model()
    kwargs = {'model_id': 'FastSAM-s', 'model_path': '/model/FastSAM-s_openvino_model'}
    assert predict_runtime(model, None, **kwargs) == ['mask']
    assert not model_hot.status()['loading']
    assert any(r['tool'] == 'fastsam' for r in model_hot.status()['resident'])
    assert predict_runtime(model, None, **kwargs) == ['mask']
    assert len(model_hot._OBSERVED) == 1
