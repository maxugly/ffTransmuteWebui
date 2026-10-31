"""Model applicability, factory provenance, preset isolation and live apply."""
import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.openvino_llm.config import OpenVinoSettings, ModelEntry, load_config, save_config, validate_and_merge_config
from app.openvino_llm.profiles import describe, presets, validate_profile, effective_runtime
from app.openvino_llm.playground import request_payload
from app.openvino_llm.supervisor import OpenVinoSupervisor
from app.routes.openvino_llm import register


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('MTAPI_OPENVINO_SETTINGS', str(tmp_path / 'settings.json'))


def tiny():
    return ModelEntry(id='TinyLlama-1.1B-Chat-v1.0-int4-ov', context_window=2048,
                      max_tokens=2048, capabilities={'tools': False, 'reasoning': False})


def test_factories_are_model_limited_and_deduplicated():
    data = describe(tiny())
    assert not data['thinking_toggle']
    assert 'enable_thinking_default' not in data['generation_keys']
    assert len(data['factory_profiles']) == 1
    factory = data['factory_profiles'][0]
    assert 'Basic Chat' in factory['name']
    assert factory['values']['context_window'] == 2048
    assert factory['values']['max_tokens_default'] == 2048
    assert factory['values']['temperature_default'] == .7
    assert factory['values']['top_p_default'] is None
    assert factory['values']['runtime']['kv_cache_precision'] == 'auto'
    assert 'prompt' not in factory['values']
    assert factory['source']


def test_thinking_reasoning_and_engine_device_applicability():
    entry = OpenVinoSettings().active_model()
    gpu = describe(entry)
    assert gpu['thinking_toggle']
    assert any('Agentic' in p['name'] for p in gpu['factory_profiles'])
    assert 'NPU' not in describe(tiny())['devices']
    assert describe(entry, device='NPU')['runtime_keys'] == ['device']
    assert describe(entry, engine='genai')['runtime_keys'] == ['device', 'kv_cache_precision']


def test_presets_isolate_exact_model_and_engine_and_validate(tmp_path):
    d = describe(tiny())
    values = d['factory_profiles'][0]['values']
    presets(d, name='Quiet', values=values)
    assert presets(d)['presets'][0]['name'] == 'Quiet'
    assert presets(describe(OpenVinoSettings().active_model()))['presets'] == []
    assert presets(describe(tiny(), engine='genai'))['presets'] == []
    with pytest.raises(ValueError, match='already exists'):
        presets(d, name='Quiet', values=values)
    with pytest.raises(ValueError, match='Unsupported settings'):
        presets(d, name='Bad', values={**values, 'enable_thinking_default': True})
    with pytest.raises(ValueError, match='context_window'):
        presets(d, name='Bad', values={**values, 'context_window': 8192})
    assert [p['name'] for p in presets(d)['presets']] == ['Quiet']
    presets(d, name='Quiet', values=values, overwrite=True)
    presets(d, name='Quiet', delete=True)
    assert presets(d)['presets'] == []


@pytest.mark.parametrize('patch', [
    {'top_k_default': 1.5}, {'top_p_default': 0}, {'temperature_default': float('nan')},
    {'max_tokens_default': 3000}, {'runtime': {'device': 'NPU'}},
    {'runtime': {'ovms_max_num_seqs': -1}}, {'runtime': {'ovms_enable_prefix_caching': 'false'}},
])
def test_invalid_presets_rejected(patch):
    d = describe(tiny())
    with pytest.raises(ValueError):
        validate_profile({**d['factory_profiles'][0]['values'], **patch}, d)


def test_migration_preserves_runtime_and_model_settings(tmp_path):
    cfg = OpenVinoSettings()
    cfg.models.append(tiny())
    cfg.runtime.ovms_max_num_seqs = 7
    cfg.active_model_id = tiny().id
    save_config(cfg)
    before = load_config()
    assert all(m.runtime_profiles['playground']['ovms_max_num_seqs'] == 7 for m in before.models)
    merged = validate_and_merge_config({'temperature_default': .25}, before)
    save_config(merged)
    after = load_config()
    assert after.active_model().temperature_default == .25
    assert after.models[0].temperature_default == .7
    assert after.cage == cfg.cage
    after.models[0].runtime_profiles['playground']['device'] = 'CPU'
    assert effective_runtime(after, after.models[0]).device == 'CPU'
    assert effective_runtime(after, after.active_model()).device == 'GPU'


def test_client_values_win_and_automatic_does_not_inject_thinking():
    entry = tiny()
    entry.temperature_default = .4
    entry.top_p_default = None
    entry.top_k_default = 20
    entry.repetition_penalty_default = 1.1
    result = request_payload({'temperature': 0, 'top_k': 5, 'max_tokens': 9000}, entry)
    assert result['temperature'] == 0 and result['top_k'] == 5
    assert result['repetition_penalty'] == 1.1
    assert 'top_p' not in result and 'chat_template_kwargs' not in result
    assert result['max_tokens'] == 2048


def test_capability_edits_do_not_invent_support():
    cfg = OpenVinoSettings(models=[tiny()], active_model_id=tiny().id)
    merged = validate_and_merge_config({'capabilities': {'tools': True, 'reasoning': True}}, cfg)
    assert not merged.active_model().capabilities.tools
    assert not merged.active_model().capabilities.reasoning


def test_preset_routes_return_operational_errors_and_do_not_apply():
    app = FastAPI()
    register(app)
    client = TestClient(app)
    before = load_config().model_dump()
    d = client.get('/api/openvino/model-settings', params={'model_id': tiny().id}).json()
    assert d['ok']
    result = client.post('/api/openvino/presets', json={
        'model_id': tiny().id, 'name': 'Test', 'values': d['factory_profiles'][0]['values'],
    })
    assert result.status_code == 200 and result.json()['ok']
    assert load_config().model_dump() == before
    result = client.post('/api/openvino/presets', json={'model_id': tiny().id, 'name': 'Bad', 'values': {'prompt': 'override'}})
    assert result.status_code == 200 and result.json()['ok'] is False
    assert client.get('/api/openvino/model-settings', params={'model_id': 'nope'}).json()['ok'] is False
    missing = client.get('/api/openvino/model-settings')
    assert missing.status_code == 200 and missing.json()['ok'] is False


def test_sampling_only_apply_preserves_warm_process(monkeypatch):
    cfg = load_config()
    save_config(cfg)
    supervisor = OpenVinoSupervisor()
    supervisor._proc = type('Proc', (), {'returncode': None})()
    supervisor.status = AsyncMock(return_value={'ok': True})
    supervisor.restart = AsyncMock(return_value={'ok': True})
    assert asyncio.run(supervisor.update_config({'temperature_default': .42}))['ok']
    supervisor.restart.assert_not_awaited()
    assert asyncio.run(supervisor.update_config({'runtime': {'ovms_max_num_seqs': 4}}))['ok']
    supervisor.restart.assert_awaited_once()


def test_model_switch_restores_its_runtime_profile():
    cfg = load_config()
    first = cfg.active_model()
    first.runtime_profiles['playground']['device'] = 'CPU'
    other = tiny()
    other.runtime_profiles['playground'] = {'device': 'GPU', 'ovms_max_num_seqs': 12}
    cfg.models.append(other)
    cfg.active_model_id = other.id
    cfg.runtime.ovms_max_num_seqs = 12
    switched = validate_and_merge_config({'active_model_id': first.id}, cfg)
    assert switched.runtime.device == 'CPU'
    assert switched.models[1].runtime_profiles['playground']['ovms_max_num_seqs'] == 12


def test_top_k_all_tokens_is_native_engine_specific():
    d = describe(tiny())
    assert validate_profile({'top_k_default': -1}, d)['top_k_default'] == -1
    with pytest.raises(ValueError):
        validate_profile({'top_k_default': -1}, describe(tiny(), engine='genai'))


def test_custom_thinking_comes_from_exported_template(tmp_path):
    from app.openvino_llm.profiles import supports_thinking
    entry = ModelEntry(id='custom-heretic', model_path=str(tmp_path), capabilities={'reasoning': True})
    assert not supports_thinking(entry)
    # A model name or capability alone cannot enable the switch.
    (tmp_path / 'chat_template.jinja').write_text('{{ messages }}')
    assert not describe(entry)['thinking_toggle']
    (tmp_path / 'chat_template.jinja').write_text('{% if enable_thinking is defined and enable_thinking is false %}<think>\n</think>{% endif %}')
    assert describe(entry)['thinking_toggle']
    payload = request_payload({'messages': [{'role': 'user', 'content': 'hello'}]}, entry)
    assert payload['chat_template_kwargs']['enable_thinking'] is False
    payload = request_payload({'chat_template_kwargs': {'enable_thinking': True}}, entry)
    assert payload['chat_template_kwargs']['enable_thinking'] is True
    (tmp_path / 'chat_template.jinja').unlink()
    (tmp_path / 'tokenizer_config.json').write_text(json.dumps({'chat_template': '{% if enable_thinking %}yes{% endif %}'}))
    assert supports_thinking(entry)
