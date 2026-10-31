"""HF discovery, revision integrity, fit and request-evidence boundaries."""
import copy
import json
import time
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import job_control
from app.openvino_llm import hf_catalog as hf, catalog
from app.openvino_llm.config import load_config, save_config, ModelEntry
from app.routes.openvino_llm import register


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('MTAPI_OPENVINO_SETTINGS', str(tmp_path / 'settings.json'))
    monkeypatch.setattr(hf, 'ROOT', tmp_path / 'weights')
    monkeypatch.setattr(hf, 'META', tmp_path / 'metadata')
    monkeypatch.setattr(hf, '_refresh', {'state': 'idle'})
    monkeypatch.setattr(catalog, '_download', {'state': 'idle'})


def candidate(repo='Author/Small-int4-ov'):
    return {'repo_id': repo, 'revision': 'a'*40, 'files': {n: 2 for n in hf.REQUIRED},
            'weight_bytes': 1024**3, 'download_bytes': 1024**3,
            'supports_thinking_toggle': True, 'tools': True, 'reasoning': True,
            'variant': 'Heretic', 'compression': {}, 'model_config': {
                'architectures': ['Qwen3ForCausalLM'], 'num_hidden_layers': 28,
                'num_attention_heads': 16, 'num_key_value_heads': 8,
                'hidden_size': 2048, 'max_position_embeddings': 32768}}


def cache(rows, updated=None):
    hf.atomic(hf.cache_path(), {'models': rows, 'updated_at': time.time() if updated is None else updated})


def test_fit_uses_context_kv_and_total_weights(monkeypatch):
    monkeypatch.setattr('app.openvino_llm.cage.mem_available_mb', lambda: (32, 16384))
    row = candidate();fit = hf.suitability(row)
    assert not fit['experimental']
    assert fit['estimated_memory_bytes'] > row['weight_bytes'] + 1024**3
    row['weight_bytes'] = 20*1024**3
    assert hf.suitability(row)['experimental']
    row = candidate();row['model_config'].pop('num_hidden_layers')
    assert hf.suitability(row)['experimental']
    row = candidate();row['model_config']['architectures'] = ['UnknownForCausalLM']
    assert hf.suitability(row)['experimental']


def test_merges_full_repo_identity_and_preserves_playground():
    cache([candidate('A/Shared'), candidate('B/Shared'), candidate('OpenVINO/Keep')])
    base = [{'repo_id':'OpenVINO/Keep', 'id':'Keep', 'model_path':'/old', 'source':'playground'}]
    rows=hf.merge_rows(base)
    assert len(rows)==3
    assert len({r['id'] for r in rows})==3
    assert rows[0]['id']=='Keep' and rows[0]['model_path']=='/old'
    assert {r['id'] for r in rows[1:]}=={'A/Shared','B/Shared'}
    assert load_config().active_model_id not in {'A/Shared','B/Shared'}


def test_inspect_requires_real_export_and_pins_metadata(monkeypatch, tmp_path):
    import huggingface_hub
    row=candidate();files=dict(row['files']);files['tokenizer_config.json']=100
    info=NS(sha=row['revision'],pipeline_tag='text-generation',siblings=[])
    def model_info(*a, **kw):
        info.siblings=[NS(rfilename=n,size=s) for n,s in files.items()]
        return info
    calls=[]
    def download(repo, name, **kw):
        calls.append(kw)
        p=tmp_path/name
        p.write_text(json.dumps(row['model_config'] if name=='config.json' else {'chat_template':'{% if enable_thinking %}<think>{% endif %} {{ tools }} <tool_call>'}))
        return str(p)
    monkeypatch.setattr(huggingface_hub,'hf_hub_download',download)
    result=hf.inspect_repo(NS(model_info=model_info),row['repo_id'])
    assert result['supports_thinking_toggle'] and result['tools']
    assert all(c['revision']==row['revision'] for c in calls)
    assert all('token' not in c for c in calls) # standard HF authentication resolution
    files.pop('openvino_model.xml')
    assert hf.inspect_repo(NS(model_info=model_info),row['repo_id']) is None
    files['weights.safetensors']=100;files['model.gguf']=100
    assert hf.inspect_repo(NS(model_info=model_info),row['repo_id']) is None


def test_refresh_expiry_dedup_and_offline_cache(monkeypatch):
    row=candidate();cache([row])
    called=[]
    class Deferred:
        def __init__(self, **kw):called.append(kw)
        def start(self):pass
    monkeypatch.setattr(hf.threading,'Thread',Deferred)
    assert not hf.snapshot()['stale']
    hf.start_refresh();assert not called
    cache([row],time.time()-90000)
    hf.start_refresh();hf.start_refresh(True);assert len(called)==1
    monkeypatch.setattr(hf,'_discover',lambda: (_ for _ in ()).throw(OSError('Bearer hf_secret')))
    hf._run_refresh()
    assert hf.snapshot()['refresh']['state']=='error'
    assert hf.snapshot()['models']==[row]
    assert 'hf_secret' not in json.dumps(hf.snapshot())


def test_partial_refresh_keeps_unavailable_existing_entries(monkeypatch):
    a,b=candidate('A/one'),candidate('B/two');cache([a,b])
    monkeypatch.setattr(hf,'_discover',lambda:(None,['A/one','B/two']))
    def inspect(api,repo):
        if repo=='B/two':raise OSError('offline')
        return {**a,'revision':'b'*40}
    monkeypatch.setattr(hf,'inspect_repo',inspect)
    hf._run_refresh()
    assert len(hf.snapshot()['models'])==2
    assert hf.snapshot()['models'][0]['revision']=='b'*40


def test_download_cancellation_resumes_pinned_revision_without_loading(monkeypatch):
    import huggingface_hub
    row=candidate();cache([row]);pending=[];calls=[];cancel=[True]
    class Deferred:
        def __init__(self,**kw):pending.append(kw)
        def start(self):pass
    monkeypatch.setattr(catalog.threading,'Thread',Deferred)
    def download(*,repo_id,filename,local_dir,revision,**kw):
        calls.append(revision)
        p=Path(local_dir);p.mkdir(parents=True,exist_ok=True);(p/filename).write_text('{}')
        if cancel[0]:
            cancel[0]=False;job_control.request_cancel(catalog._download['token'])
    monkeypatch.setattr(huggingface_hub,'hf_hub_download',download)
    original=load_config().model_dump()
    result=catalog.start_download(row['repo_id']);assert result['ok']
    task=pending.pop();task['target'](*task['args'])
    assert catalog._download['state']=='cancelled'
    assert not hf.installed(row,hf.model_dir('Author/Small-int4-ov'))
    cache([{**row,'revision':'b'*40}])
    assert catalog.start_download(row['repo_id'])['ok']
    task=pending.pop();task['target'](*task['args'])
    assert catalog._download['state']=='complete'
    assert set(calls)=={'a'*40}
    assert hf.installed(row,hf.model_dir('Author/Small-int4-ov'))
    assert load_config().model_dump()==original
    assert catalog.start_download(row['repo_id'])['installed']


def test_bad_download_never_becomes_installed(monkeypatch):
    import huggingface_hub
    row=candidate();path=hf.model_dir('Author/Small-int4-ov')
    token=job_control.new_token();job_control.register(token)
    def download(**kw):
        p=Path(kw['local_dir']);p.mkdir(parents=True,exist_ok=True);(p/kw['filename']).write_text('bad size')
    monkeypatch.setattr(huggingface_hub,'hf_hub_download',download)
    catalog._download_model({**hf.merge_rows([])[0]} if hf.snapshot()['models'] else {**row,'source':'hf','model_path':str(path),'supports_vision':False},token)
    assert catalog._download['state']=='error'
    assert not hf.installed(row,path)


def test_verification_requires_revision_settings_and_artifacts(tmp_path):
    row=candidate();path=tmp_path/'model';path.mkdir()
    for name in row['files']:(path/name).write_text('{}')
    hf.atomic(path/'.hf-model.json',row)
    cfg=load_config();entry=ModelEntry(id=row['repo_id'],model_path=str(path),runtime_profiles={'playground':{'device':'GPU','kv_cache_precision':'u4'}})
    hf.record_verified(entry,cfg,'GPU','u4',{'max_tokens':32})
    proof=hf.read(path/'.hf-verified.json')
    assert proof['key']==hf.verification_key(entry,cfg)
    entry.context_window=8192
    assert proof['key']!=hf.verification_key(entry,cfg)
    entry.context_window=40960
    hf.atomic(path/'.hf-model.json',{**row,'revision':'b'*40})
    assert proof['key']!=hf.verification_key(entry,cfg)
    assert proof['request_settings']=={'max_tokens':32}


def test_routes_do_not_expose_credentials_or_register_candidates(monkeypatch):
    cache([candidate()]);app=FastAPI();register(app);client=TestClient(app)
    before=load_config().model_dump()
    response=client.get('/api/openvino/models').json()
    assert any(r['source']=='hf' for r in response['models'] if 'source' in r)
    assert load_config().model_dump()==before
    assert client.post('/api/openvino/models/refresh',json=[]).json()['ok'] is False
    assert client.post('/api/openvino/models/download/cancel').json()['ok']


@pytest.mark.parametrize('status',[401,403,429])
def test_auth_errors_are_actionable_and_redacted(status):
    exc=RuntimeError('secret signed URL?token=hf_secret')
    exc.response=NS(status_code=status)
    message=hf.safe_error(exc)
    assert 'hf_secret' not in message
    assert ('access denied' if status in (401,403) else 'rate limit') in message


@pytest.mark.parametrize('mode,expected',[('answer',True),('empty',False),('reasoning',False),('missing_done',False)])
def test_only_completed_answer_records_verification(tmp_path,monkeypatch,mode,expected):
    import asyncio
    from unittest.mock import AsyncMock
    from fastapi.responses import JSONResponse, StreamingResponse
    from app.openvino_llm import worker
    row=candidate();path=tmp_path/'loaded';path.mkdir()
    for name in row['files']:(path/name).write_text('{}')
    hf.atomic(path/'.hf-model.json',row)
    entry=ModelEntry(id=row['repo_id'],model_path=str(path))
    cfg=load_config();cfg.models=[entry];cfg.active_model_id=entry.id;save_config(cfg)
    monkeypatch.setattr(worker,'_request_gate',asyncio.Lock())
    monkeypatch.setattr(worker,'_keep_model_loaded',lambda:True)
    monkeypatch.setattr(worker,'_state',{'model_state':'hot','loaded_model_id':entry.id,'loaded_model_path':str(path),'device':'GPU','kv_cache_precision':'u4','pipe':object()})
    message={'content':'OK'} if mode in ('answer','missing_done') else {'reasoning_content':'thinking'} if mode=='reasoning' else {'content':''}
    body={'choices':[{'message':message,'finish_reason':'stop'}]}
    if mode=='missing_done':
        async def stream():
            yield 'data: '+json.dumps({'choices':[{'delta':message,'finish_reason':'stop'}]})+'\n\n'
        response=StreamingResponse(stream())
    else:response=JSONResponse(body)
    monkeypatch.setattr(worker,'_chat_completions_impl',AsyncMock(return_value=response))
    request=NS(json=AsyncMock(return_value={'stream':mode=='missing_done'}))
    async def run():
        reply=await worker.chat_completions(request)
        if isinstance(reply,StreamingResponse):
            async for _ in reply.body_iterator:pass
    asyncio.run(run())
    assert (path/'.hf-verified.json').exists() is expected
    assert not worker._request_gate.locked()


def test_switching_active_model_requires_explicit_load(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock
    from app.openvino_llm.supervisor import OpenVinoSupervisor
    cfg=load_config();other=ModelEntry(id='Other',model_path='/not-loaded',capabilities={'tools':False,'reasoning':False})
    cfg.models.append(other);save_config(cfg)
    supervisor=OpenVinoSupervisor();supervisor._proc=NS(returncode=None)
    supervisor.status=AsyncMock(return_value={'ok':True});supervisor.restart=AsyncMock(return_value={'ok':True})
    asyncio.run(supervisor.update_config({'active_model_id':'Other'}))
    supervisor.restart.assert_awaited_once_with(re_warm=False)


def test_installed_revision_metadata_survives_new_discovery():
    first=candidate();path=hf.model_dir('Author/Small-int4-ov');path.mkdir(parents=True)
    for name in first['files']:(path/name).write_text('{}')
    hf.atomic(path/'.hf-model.json',{'repo_id':first['repo_id'],'revision':first['revision'],'files':first['files'],
              'export_metadata':{k:v for k,v in first.items() if k not in ('repo_id','revision','files')}})
    newer=copy.deepcopy(first);newer['revision']='b'*40;newer['model_config']['max_position_embeddings']=1024
    cache([newer]);row=hf.merge_rows([])[0]
    assert row['installed'] and row['update_available']
    assert row['revision']==first['revision']
    assert row['native_context_window']==32768


def test_path_identity_cannot_collide_on_separator():
    assert hf.model_dir('A---B/C') != hf.model_dir('A/B---C')


def test_existing_custom_presets_keep_local_identity(tmp_path):
    from app.openvino_llm.profiles import describe, presets
    row=candidate();path=tmp_path/'Author---Small-int4-ov';path.mkdir()
    for name in row['files']:(path/name).write_text('{}')
    entry=ModelEntry(id='My legacy model',model_path=str(path))
    cfg=load_config();cfg.models.append(entry);save_config(cfg);cache([row])
    identity=f'local:{entry.id}:{entry.model_path}'
    hf.atomic(hf.cache_path().with_name('presets.json'),{identity+'|playground':{'My existing preset':{'temperature_default':.25}}})
    descriptor=describe(entry)
    assert descriptor['identity']==identity
    assert presets(descriptor)['presets'][0]['name']=='My existing preset'


def test_adoption_validates_existing_download_revision_and_preserves_presets(tmp_path):
    row=candidate();path=tmp_path/'Author---Small-int4-ov';path.mkdir()
    meta=path/'.cache/huggingface/download';meta.mkdir(parents=True)
    for name,size in row['files'].items():
        (path/name).write_text('{}');(meta/(name+'.metadata')).write_text(row['revision']+'\netag\n0\n')
    cfg=load_config();entry=ModelEntry(id='My old ID',model_path=str(path));cfg.models.append(entry);save_config(cfg)
    hf.adopt_configured_exports([{**row,'revision':'b'*40}]);assert not hf.manifest(path)
    hf.adopt_configured_exports([row]);saved=hf.manifest(path)
    assert saved['revision']==row['revision']
    assert saved['preset_identity']==f'local:{entry.id}:{entry.model_path}'
    assert not (path/'.hf-verified.json').exists()


def test_disconnect_during_verification_input_read_releases_gate(monkeypatch):
    import asyncio
    from unittest.mock import AsyncMock
    from app.openvino_llm import worker
    monkeypatch.setattr(worker,'_request_gate',asyncio.Lock())
    monkeypatch.setattr(worker,'_state',{'pipe':None})
    request=NS(json=AsyncMock(side_effect=RuntimeError('Disconnected')))
    with pytest.raises(RuntimeError,match='Disconnected'):
        asyncio.run(worker.chat_completions(request))
    assert not worker._request_gate.locked()
