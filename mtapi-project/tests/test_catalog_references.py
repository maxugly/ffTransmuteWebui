"""Research must remain lossless and independent of all scanned data."""
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.database import audio_db, reference_metadata as refs
from app.routes.media_catalog import router


@pytest.fixture
def catalog(tmp_path, monkeypatch):
    monkeypatch.setenv('MTAPI_MEDIA_CATALOG_DB', str(tmp_path / 'catalog.db'))
    refs.init_db()
    with audio_db.get_db() as db:
        db.execute("INSERT INTO media(path,type,artist,title,album,tempo,tempo_detected,"
                   "tempo_source,key_name,key_detected,key_source,raw_metadata) "
                   "VALUES ('/music/song.flac','audio','ICP','Hokus Pokus','The Great Milenko',"
                   "95,94,'tagged','C major','B minor','tagged','{\"votes\": [94,188]}')")
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def entry(**kwargs):
    return {'artist': 'Insane Clown Posse', 'track_title': 'Hokus Pokus',
            'release_or_album': 'The Great Milenko', 'recording_version': 'Album version',
            'key_reported_raw': 'B', 'mode_source_confirmed': '',
            'producer_credit': 'Mike E. Clark*', 'bpm_reported': '92',
            'source_url': 'https://example.org/song', 'notes': 'Uncertain', **kwargs}


def write(tmp_path, entries):
    path = tmp_path / 'research.json'
    path.write_text(json.dumps(entries), encoding='utf-8')
    return str(path)


def test_lossless_idempotent_conflicts_and_independent_edit(catalog, tmp_path):
    before = audio_db.get_row('/music/song.flac')
    records = [entry(), entry(source_url='https://other.org/song', bpm_reported='184'),
               entry(release_or_album='Compilation'), entry(recording_version='Remix')]
    path = write(tmp_path, records)
    assert refs.import_catalog(path) == {'inserted': 4, 'existing': 0, 'total': 4}
    assert refs.import_catalog(path) == {'inserted': 0, 'existing': 4, 'total': 4}
    data = catalog.get('/api/media-catalog/references', params={'path': before['path']}).json()
    assert data['ok']
    assert data['detected'] == {'bpm': 94, 'key': 'B minor', 'camelot': '10A'}
    assert len(data['references']) == 4
    assert all('candidate' in r['match'] for r in data['references'])  # multiple recordings
    assert [r['metadata'] for r in data['references']] == records
    id_ = data['references'][0]['id']
    edited = {**records[0], 'notes': 'New research', 'unrecognized_field': {'preserve': True}}
    assert catalog.post('/api/media-catalog/references/update', json={'id': id_, 'metadata': edited}).json()['ok']
    assert catalog.post('/api/media-catalog/references/link', json={'id': id_, 'path': before['path'], 'included': True}).json()['ok']
    results = refs.comparison(before['path'])['references']
    assert results[0]['match'] == 'manual'
    assert results[0]['metadata'] == edited
    with audio_db.get_db() as db:
        revision = db.execute('SELECT payload FROM research_revision').fetchone()[0]
    assert json.loads(revision) == records[0]
    assert audio_db.get_row(before['path']) == before


def test_matching_uses_tags_and_never_invents_mode(catalog, tmp_path):
    refs.import_catalog(write(tmp_path, [entry(), entry(release_or_album='Compilation')]))
    result = refs.comparison('/music/song.flac')['references']
    assert 'recording unverified' in result[0]['match']
    assert 'candidate' in result[1]['match']
    assert result[0]['metadata']['mode_source_confirmed'] == ''
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET album=NULL WHERE path='/music/song.flac'")
    assert all('candidate' in r['match'] for r in refs.comparison('/music/song.flac')['references'])
    with audio_db.get_db() as db:
        db.execute("UPDATE media SET artist=NULL,title=NULL WHERE path='/music/song.flac'")
    assert not refs.comparison('/music/song.flac')['references']
    assert len(refs.comparison('/music/song.flac', search='Hokus')['references']) == 2


def test_invalid_import_atomic_and_http_failures(catalog, tmp_path):
    path = write(tmp_path, [entry(), {'artist': 'ICP'}])
    res = catalog.post('/api/media-catalog/references/import', json={'path': path})
    assert res.status_code == 200 and not res.json()['ok']
    assert refs.comparison()['total'] == 0
    for endpoint, body in [('import', {'path': 'relative.json'}), ('update', {'id': 999, 'metadata': entry()}),
                           ('link', {'included': 'false'}), ('import', [])]:
        res = catalog.post('/api/media-catalog/references/' + endpoint, json=body)
        assert res.status_code == 200 and not res.json()['ok']


def test_csv_and_revised_import_add_evidence(catalog, tmp_path):
    path = tmp_path / 'research.csv'
    path.write_text('artist,track_title,source_bpm,key_reported_raw\nICP,Hokus Pokus,92,B\n')
    assert refs.import_catalog(str(path))['inserted'] == 1
    path.write_text('artist,track_title,source_bpm,key_reported_raw\nICP,Hokus Pokus,184,B\n')
    assert refs.import_catalog(str(path))['total'] == 2


def test_actual_catalog_lossless(catalog):
    path = Path(__file__).resolve().parents[2] / 'junk/icp_psychopathic_full_chart.json'
    records = json.loads(path.read_text())
    assert refs.import_catalog(str(path))['inserted'] == len(records) == 148
    all_records = []
    for offset in (0, 50, 100):
        all_records += [r['metadata'] for r in refs.comparison(offset=offset)['references']]
    assert all_records == records
