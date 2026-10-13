"""Reference notes and explicit model/file associations stay independent."""
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from app.routes import audio_references as refs


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('MTAPI_AUDIO_REFERENCES_DB', str(tmp_path / 'references.sqlite3'))
    app = FastAPI()
    refs.register(app)
    with TestClient(app) as client:
        yield client


def test_catalog_and_bundled_sources(client):
    catalog = client.get('/api/audio-references').json()
    assert catalog['ok'] and len(catalog['models']) == 64
    assert len({m['id'] for m in catalog['models']}) == 64
    assert all(len(m['values']) == len(catalog['columns']) == 12 for m in catalog['models'])
    for name in ('audio-supertable.csv', 'audio-supertable.md', 'audio-supertable.json',
                 'audio-supertable.html', 'tts-supertable.csv', 'tts-supertable.md',
                 'tts-supertable.json', 'tts-supertable.html', 'source.txt'):
        response = client.get('/api/audio-references/source/' + name)
        assert response.status_code == 200 and len(response.content) > 100
        assert response.headers['content-disposition'].startswith('attachment;')

    # Voice Mod library checks
    voicemod = client.get('/api/voicemod-references').json()
    assert voicemod['ok'] and len(voicemod['models']) == 23
    assert len({m['id'] for m in voicemod['models']}) == 23
    assert all(len(m['values']) == len(voicemod['columns']) == 12 for m in voicemod['models'])
    for name in ('voicemod-supertable.csv', 'voicemod-supertable.md', 'voicemod-supertable.json',
                 'voicemod-supertable.html', 'source.txt'):
        response = client.get('/api/voicemod-references/source/' + name)
        assert response.status_code == 200 and len(response.content) > 100


def test_notes_persist_and_stale_writer_cannot_overwrite(client):
    url = '/api/audio-references/model/kokoro-82m'
    assert client.get(url).json()['note'] == {'text': '', 'revision': 0}
    assert client.post(url + '/note', json={'text': 'Listen to take 2', 'revision': 0}).json()['revision'] == 1
    stale = client.post(url + '/note', json={'text': 'stale', 'revision': 0})
    assert stale.status_code == 200 and not stale.json()['ok']
    assert client.get(url).json()['note'] == {'text': 'Listen to take 2', 'revision': 1}
    assert client.get('/api/audio-references/model/chatterbox-turbo').json()['note']['text'] == ''
    assert client.get('/api/voicemod-references/model/rvc-v2').json()['note']['text'] == ''
    assert client.post(url + '/note', json={'text': '', 'revision': 1}).json()['ok']
    assert client.get(url).json()['note']['text'] == ''


def test_file_tags_are_idempotent_many_to_many_and_never_delete_files(client, tmp_path):
    file = tmp_path / 'take.txt'
    file.write_text('original data')
    a, b = '/api/audio-references/model/kokoro-82m', '/api/audio-references/model/chatterbox-turbo'
    for url in (a, a, b):
        assert client.post(url + '/file', json={'path': str(file), 'kind': 'output'}).json()['ok']
    tagged = client.get(a).json()['files']
    assert len(tagged) == 1 and tagged[0]['tags'] == ['chatterbox-turbo', 'kokoro-82m']
    file_id = tagged[0]['id']
    assert not client.get(b + f'/file/{file_id}').json()['ok']
    assert client.get(a + f'/file/{file_id}').text == 'original data'
    client.post(b + f'/file/{file_id}/untag')
    assert len(client.get(a).json()['files']) == 1
    client.post(a + f'/file/{file_id}/untag')
    assert not client.get(a).json()['files']
    assert len(client.get(b).json()['files']) == 1
    assert file.read_text() == 'original data'


def test_missing_file_stays_visible_but_cannot_download(client, tmp_path):
    file = tmp_path / 'gone.txt'
    file.write_text('gone')
    url = '/api/audio-references/model/kokoro-82m'
    client.post(url + '/file', json={'path': str(file)})
    file.unlink()
    row = client.get(url).json()['files'][0]
    assert not row['exists']
    assert not client.get(url + f"/file/{row['id']}").json()['ok']


@pytest.mark.parametrize('body', [
    {'path': 'relative.wav'}, {'path': ''}, {'path': '/does/not/exist.wav'},
    {'path': []}, {'path': '/'},
])
def test_invalid_file_paths_are_http_200_errors(client, body):
    response = client.post('/api/audio-references/model/kokoro-82m/file', json=body)
    assert response.status_code == 200 and not response.json()['ok']


def test_unknown_models_and_invalid_notes(client):
    assert not client.get('/api/audio-references/model/unknown').json()['ok']
    url = '/api/audio-references/model/kokoro-82m/note'
    for body in ({'text': [], 'revision': 0}, {'text': 'x', 'revision': -1}, {'text': 'x'}):
        response = client.post(url, json=body)
        assert response.status_code == 200 and not response.json()['ok']
    assert not client.get('/api/audio-references/source/anything.txt').json()['ok']
