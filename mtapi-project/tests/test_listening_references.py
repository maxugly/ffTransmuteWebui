"""Listening catalog evidence and storage boundaries with the generation library."""
import csv
import io

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from app.routes import audio_references as refs


@pytest.fixture
def client(tmp_path, monkeypatch):
    for key, name in [('MTAPI_AUDIO_REFERENCES_DB', 'audio.sqlite3'),
                      ('MTAPI_LISTENING_REFERENCES_DB', 'listening.sqlite3')]:
        monkeypatch.setenv(key, str(tmp_path / name))
    app = FastAPI()
    refs.register(app)
    with TestClient(app) as client:
        yield client


def test_catalog_covers_tasks_and_carries_primary_evidence(client):
    catalog = client.get('/api/listening-references').json()
    assert catalog['ok']
    assert len(catalog['models']) == len({m['id'] for m in catalog['models']}) == 47
    assert len(catalog['columns']) == 14
    required = {'Wake words', 'Transcription', 'Diarization', 'Speaker recognition',
                'Sound descriptions', 'Music descriptions', 'Audio to MIDI',
                'Pitch tracking', 'Source separation', 'Speech enhancement', 'Fingerprinting'}
    assert required <= set(catalog['categories'])
    for model in catalog['models']:
        assert len(model['values']) == 14
        assert model['tasks'] and set(model['tasks']) <= set(catalog['categories'])
        assert model['checked'] == model['values'][13] == '2026-10-10'
        assert all(s['url'].startswith('https://') for s in model['sources'])
        assert model['sources'][0]['url'] == model['values'][12]
    assert any('who spoke when' in definition for _, definition in catalog['glossary'])
    assert len(client.get('/api/audio-references').json()['models']) == 64


def test_bundled_exports_match_catalog_and_cannot_cross_libraries(client):
    data = client.get('/api/listening-references').json()
    response = client.get('/api/listening-references/source/listening-supertable.csv')
    assert response.headers['content-disposition'].startswith('attachment;')
    assert response.headers['x-content-type-options'] == 'nosniff'
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows == [data['columns']] + [m['values'] for m in data['models']]
    source = client.get('/api/listening-references/source/listening-supertable.json').json()
    assert source['rows'] == [m['values'] for m in data['models']]
    for item in data['source_files']:
        assert len(client.get('/api/listening-references/source/' + item['name']).content) > 100
    assert not client.get('/api/listening-references/source/source.txt').json()['ok']
    assert not client.get('/api/audio-references/source/listening-supertable.json').json()['ok']


def test_notes_persist_and_reject_stale_updates(client):
    url = '/api/listening-references/model/spotify-basic-pitch'
    assert client.get(url).json()['note']['revision'] == 0
    assert client.post(url + '/note', json={'text': 'Try isolated piano stem', 'revision': 0}).json()['ok']
    assert not client.post(url + '/note', json={'text': 'stale', 'revision': 0}).json()['ok']
    assert client.get(url).json()['note'] == {'text': 'Try isolated piano stem', 'revision': 1}
    assert client.get('/api/listening-references/model/mt3').json()['note']['text'] == ''
    assert not client.get('/api/audio-references/model/spotify-basic-pitch').json()['ok']
    assert not client.get('/api/listening-references/model/kokoro-82m').json()['ok']


def test_tags_are_scoped_multi_model_and_do_not_modify_file(client, tmp_path):
    file = tmp_path / 'piano.mid'
    file.write_bytes(b'MThd-test-fixture')
    a = '/api/listening-references/model/spotify-basic-pitch'
    b = '/api/listening-references/model/mt3'
    generation = '/api/audio-references/model/kokoro-82m'
    for url in (a, a, b, generation):
        assert client.post(url + '/file', json={'path': str(file), 'kind': 'reference'}).json()['ok']
    row = client.get(a).json()['files'][0]
    assert len(client.get(a).json()['files']) == 1
    assert row['tags'] == ['mt3', 'spotify-basic-pitch']
    assert client.get(generation).json()['files'][0]['tags'] == ['kokoro-82m']
    assert client.get(a + f"/file/{row['id']}").content == b'MThd-test-fixture'
    assert not client.get(b + f"/file/{row['id']}").json()['ok']
    assert client.post(a + f"/file/{row['id']}/untag").json()['ok']
    assert not client.get(a).json()['files']
    assert client.get(b).json()['files'] and client.get(generation).json()['files']
    assert file.read_bytes() == b'MThd-test-fixture'


def test_invalid_writes_keep_http_200_contract(client):
    url = '/api/listening-references/model/spotify-basic-pitch'
    for suffix, body in [('/note', {'text': 'x'}), ('/file', {'path': 'relative.mid'}),
                         ('/note', {'text': [], 'revision': 0})]:
        response = client.post(url + suffix, json=body)
        assert response.status_code == 200 and not response.json()['ok']
