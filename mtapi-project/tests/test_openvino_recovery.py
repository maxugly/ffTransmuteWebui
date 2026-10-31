"""Retention persistence, bounded requests, disconnect cleanup, and recovery."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.responses import JSONResponse, StreamingResponse

from app import model_hot
from app.media import performance
from app.openvino_llm import playground, worker
from app.openvino_llm.config import OpenVinoSettings


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv('MTAPI_OPENVINO_SETTINGS', str(tmp_path/'vino.json'))
    monkeypatch.setattr(performance, 'SETTINGS_PATH', tmp_path/'preferences.json')
    monkeypatch.setattr(performance, '_settings_cache', None)
    monkeypatch.setattr(worker, '_request_gate', asyncio.Lock())
    monkeypatch.setattr(worker, '_state', {'pipe': None, 'generating': False})


def test_openvino_keep_loaded_roundtrips_and_releases_only_openvino(monkeypatch):
    from app.openvino_llm.supervisor import get_supervisor
    supervisor = get_supervisor()
    release = AsyncMock(return_value={'ok': True})
    monkeypatch.setattr(supervisor, 'release_if_idle', release)
    async def run():
        await model_hot.configure('tts', True)
        on = await model_hot.configure('openvino', True)
        assert on['policies']['openvino'] is True
        assert worker._keep_model_loaded()
        release.assert_not_awaited()
        off = await model_hot.configure('openvino', False)
        assert off['policies']['openvino'] is False
        assert off['policies']['tts'] is True
        assert not worker._keep_model_loaded()
        release.assert_awaited_once()
    asyncio.run(run())


@pytest.mark.parametrize('keep', [True, False])
def test_request_finish_respects_retention_and_releases_gate(monkeypatch, keep):
    monkeypatch.setattr(worker, '_keep_model_loaded', lambda: keep)
    worker._state['pipe'] = object()
    unloaded = []
    def unload():
        unloaded.append(True)
        worker._state['pipe'] = None
    monkeypatch.setattr(worker, 'unload_pipeline_sync', unload)
    monkeypatch.setattr(worker, '_chat_completions_impl', AsyncMock(return_value=JSONResponse({'ok': True})))
    asyncio.run(worker.chat_completions(None))
    assert bool(unloaded) is (not keep)
    assert not worker._request_gate.locked()


def test_overlapping_requests_refused_without_starting_another_load(monkeypatch):
    impl = AsyncMock()
    monkeypatch.setattr(worker, '_chat_completions_impl', impl)
    async def run():
        await worker._request_gate.acquire()
        try:
            response = await worker.chat_completions(None)
            assert json.loads(response.body)['error']['code'] == 'server_busy'
            impl.assert_not_awaited()
        finally:
            worker._request_gate.release()
    asyncio.run(run())


def test_keep_off_during_request_defers_release(monkeypatch):
    monkeypatch.setattr(worker, '_keep_model_loaded', lambda: False)
    unloaded = []
    monkeypatch.setattr(worker, 'unload_pipeline_sync', lambda: unloaded.append(True))
    async def run():
        await worker._request_gate.acquire()
        try:
            result = await worker.release_if_idle()
            assert result['release_pending'] and not unloaded
        finally:
            worker._request_gate.release()
    asyncio.run(run())


def test_cancelled_stream_unloads_even_with_keep_loaded(monkeypatch):
    monkeypatch.setattr(worker, '_keep_model_loaded', lambda: True)
    worker._state['pipe'] = object()
    unloaded = []
    def unload():
        unloaded.append(True)
        worker._state['pipe'] = None
    monkeypatch.setattr(worker, 'unload_pipeline_sync', unload)
    closed = []
    async def stream():
        try:
            yield 'data: first\n\n'
            await asyncio.sleep(60)
        finally:
            closed.append(True)
    monkeypatch.setattr(worker, '_chat_completions_impl', AsyncMock(return_value=StreamingResponse(stream())))
    async def run():
        response = await worker.chat_completions(None)
        await anext(response.body_iterator)
        assert worker._request_gate.locked()
        await response.body_iterator.aclose()
        assert unloaded and closed
        assert not worker._request_gate.locked()
    asyncio.run(run())


def test_stream_has_total_deadline_even_when_chunks_keep_arriving(monkeypatch):
    class SlowStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            while True:
                await asyncio.sleep(.02)
                yield b'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=SlowStream()))
    original = httpx.AsyncClient
    monkeypatch.setattr(playground.httpx, 'AsyncClient', lambda **kw: original(transport=transport, **kw))
    cfg = OpenVinoSettings(timeout_ms=1000)
    state = {}
    async def run():
        response = await playground.chat(SimpleNamespace(base_url='http://native'), {'stream': True}, cfg, cfg.active_model(), state)
        chunks = [chunk async for chunk in response.body_iterator]
        assert any('request_timeout' in chunk for chunk in chunks)
        assert any('[DONE]' in chunk for chunk in chunks)
        assert state['request_aborted'] and not state['generating']
        assert state['reply_updates'] > 1
    asyncio.run(run())


def test_nonstream_disconnect_cancels_native_request(monkeypatch):
    cancelled = []
    async def transport_handler(request):
        try:
            await asyncio.sleep(60)
        finally:
            cancelled.append(True)
    transport = httpx.MockTransport(transport_handler)
    original = httpx.AsyncClient
    monkeypatch.setattr(playground.httpx, 'AsyncClient', lambda **kw: original(transport=transport, **kw))
    cfg = OpenVinoSettings()
    state = {}
    async def disconnected():
        await asyncio.sleep(.03)
        return True
    async def run():
        response = await playground.chat(SimpleNamespace(base_url='http://native'), {}, cfg, cfg.active_model(), state,
                                         request=SimpleNamespace(is_disconnected=disconnected))
        assert json.loads(response.body)['error']['code'] == 'request_cancelled'
        assert state['request_aborted'] and cancelled and not state['generating']
    asyncio.run(run())


def test_client_close_after_done_keeps_model(monkeypatch):
    monkeypatch.setattr(worker, '_keep_model_loaded', lambda: True)
    model = object()
    worker._state['pipe'] = model
    async def stream():
        yield 'data: [DONE]\n\n'
        await asyncio.sleep(60)
    monkeypatch.setattr(worker, '_chat_completions_impl', AsyncMock(return_value=StreamingResponse(stream())))
    async def run():
        response = await worker.chat_completions(None)
        await anext(response.body_iterator)
        await response.body_iterator.aclose()
        assert worker._state['pipe'] is model
        assert not worker._request_gate.locked()
    asyncio.run(run())
