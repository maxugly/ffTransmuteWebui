import asyncio
import sys
from types import SimpleNamespace

from app import model_hot
from app.audio import tts_timing
from app.media import performance


def test_policy_defaults_and_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(performance, 'SETTINGS_PATH', tmp_path/'settings.json')
    monkeypatch.setattr(performance, '_settings_cache', None)
    assert not model_hot.enabled()
    assert asyncio.run(model_hot.configure(True))['enabled']
    assert performance.load_settings()['keep_models_hot'] is True
    asyncio.run(model_hot.configure(False))
    assert not model_hot.enabled()


def test_release_deferred_until_job_finishes(monkeypatch):
    monkeypatch.setattr(model_hot, 'ACTIVE', 0)
    monkeypatch.setattr(model_hot, 'enabled', lambda: False)
    calls=[]
    async def stop(): calls.append('worker')
    monkeypatch.setattr(model_hot, '_stop_worker', stop)
    monkeypatch.setattr(model_hot, '_clear_native', lambda: calls.append('native'))
    async def scenario():
        model_hot.begin()
        assert model_hot.status()['release_pending']
        await model_hot.release()
        assert calls == []
        await model_hot.finish()
        assert calls == ['worker','native']
    asyncio.run(scenario())


def test_native_release_only_touches_loaded_caches(monkeypatch):
    cache={'checkpoint': object()}
    fake=SimpleNamespace(_runtime_model_cache=cache)
    monkeypatch.setitem(sys.modules,'app.filters.fastsam',fake)
    monkeypatch.setattr(model_hot,'CACHES',{'app.filters.fastsam':(None,'_runtime_model_cache'), 'missing.neural.library':(None,'_model')})
    model_hot._clear_native()
    assert cache == {}
    assert 'missing.neural.library' not in sys.modules


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


def test_shared_operation_policy_overrides_legacy_flag(monkeypatch):
    from pydantic import BaseModel
    from app import op_runner, media
    from app.contract import OperationSpec, OperationResult
    class Params(BaseModel):
        keep_model_warm: bool = False
    monkeypatch.setattr(model_hot,'ACTIVE',0)
    observed=[]
    async def handler(params):
        observed.append((params.keep_model_warm,model_hot.ACTIVE))
        return OperationResult(ok=True,operation='hot-test')
    async def no_record(*args,**kwargs):pass
    async def no_stop():pass
    monkeypatch.setattr(media,'record_operation',no_record)
    monkeypatch.setattr(model_hot,'_stop_worker',no_stop)
    monkeypatch.setattr(model_hot,'_clear_native',lambda:None)
    spec=OperationSpec(id='hot-test',summary='test',description='test',params_model=Params,handler=handler)
    for hot in (True,False):
        monkeypatch.setattr(model_hot,'enabled',lambda:hot)
        result=asyncio.run(op_runner.run_registered_op(spec,Params(keep_model_warm=not hot),token='policy-test'))
        assert result.ok and model_hot.ACTIVE==0
    assert observed==[(True,1),(False,1)]
