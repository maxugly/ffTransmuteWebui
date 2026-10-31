import asyncio
from types import SimpleNamespace as NS

import pytest

from app.openvino_llm import cli, catalog, profiles
from app.openvino_llm.config import OpenVinoSettings, ModelEntry


def test_installed_picker_respects_engine_and_full_ids(monkeypatch):
    rows = [{'id': 'a/Small', 'installed': True, 'selectable': True},
            {'id': 'b/Small', 'installed': True, 'selectable': True},
            {'id': 'missing', 'installed': False},
            {'id': 'unsupported', 'installed': True, 'selectable': False}]
    monkeypatch.setattr(catalog, 'model_catalog', lambda: {'models': rows})
    assert [r['id'] for r in cli.installed_models()] == ['a/Small', 'b/Small']


def test_selection_keeps_tuning_and_existing_entries(monkeypatch):
    cfg = OpenVinoSettings()
    cfg.models[0].temperature_default = 1.234
    entry = ModelEntry(id='author/new', model_path='/absolute/model')
    monkeypatch.setattr(profiles, 'resolve_model', lambda _: (cfg, entry))
    monkeypatch.setattr(cli, 'installed_models', lambda: [{'id': entry.id}])
    patch = cli.select_config(entry.id)
    assert patch['models'][0]['temperature_default'] == 1.234
    assert patch['models'][-1]['id'] == entry.id
    assert patch['runtime'] == {'model_path': '/absolute/model'}
    assert 'api_key' not in patch


def test_missing_export_rejected(monkeypatch):
    monkeypatch.setattr(profiles, 'resolve_model', lambda _: (OpenVinoSettings(), ModelEntry()))
    monkeypatch.setattr(cli, 'installed_models', lambda: [])
    with pytest.raises(ValueError, match='not downloaded'):
        cli.select_config('missing')


def test_status_truthful_and_no_terminal_injection():
    text = cli.display({'server': {'state': 'up', 'pid': 5}, 'model': {
        'state': 'loading', 'loaded_model_id': '\x1b[31mname',
        'activity': {'phase': 'loading', 'detail': 'Compiling model'},
        'last_error': 'load failed'}})
    assert 'State: loading' in text and 'Compiling model' in text
    assert 'Error: load failed' in text and '\x1b' not in text
    assert 'verified' not in text.lower()


def test_offline_status_does_not_start_service(monkeypatch):
    async def absent(*a, **kw): return None
    monkeypatch.setattr(cli, 'request', absent)
    assert asyncio.run(cli.main_async(NS(command='status'))) == 1


def test_private_socket_scoped_to_settings(tmp_path, monkeypatch):
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(cli, 'settings_path', lambda: tmp_path / 'a.json')
    first = cli.socket_path()
    monkeypatch.setattr(cli, 'settings_path', lambda: tmp_path / 'b.json')
    assert cli.socket_path() != first
    assert first.parent.stat().st_mode & 0o777 == 0o700


def test_foreground_service_owns_shutdown_and_refuses_port_takeover(tmp_path, monkeypatch):
    from app.openvino_llm import supervisor
    monkeypatch.setenv('XDG_RUNTIME_DIR', str(tmp_path))
    monkeypatch.setattr(cli, 'settings_path', lambda: tmp_path / 'settings.json')
    calls = []

    class FakeSupervisor:
        _proc = object()
        async def start(self, **kw):
            calls.append(('start', kw))
            return {'ok': True}
        async def status(self):
            return {'ok': True, 'server': {'state': 'up'}, 'model': {'state': 'cold'}}
        async def stop(self): calls.append(('stop', {}))

    monkeypatch.setattr(supervisor, 'OpenVinoSupervisor', FakeSupervisor)

    async def exercise():
        task = asyncio.create_task(cli.serve(cold=True))
        try:
            for _ in range(50):
                if cli.socket_path().exists(): break
                await asyncio.sleep(.01)
            status = await cli.request('status')
            assert status['server']['state'] == 'up'
            assert 'config' not in status
            assert (await cli.request('stop'))['ok']
            await asyncio.wait_for(task, 3)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        assert not cli.socket_path().exists()

    asyncio.run(exercise())
    assert calls == [('start', {'auto_load': False, 'kill_stray': False}), ('stop', {})]
