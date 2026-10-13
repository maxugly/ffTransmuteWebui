"""Audio model reference library: source facts, notes and explicit file tags.

File tags describe an association, never infer which model generated a file.
The store is independent of the media catalog, pools and named projects.
"""
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

ROOT = Path(__file__).resolve().parents[3]


def create_reference_router(prefix, source_dir, source_name, source_files, db_env, db_name):
    """Each library owns its catalog cache and independent transactional store."""
    SOURCE_DIR = source_dir
    router = APIRouter(prefix=prefix, tags=[prefix.strip("/")])

    @lru_cache(maxsize=1)
    def catalog():
        source = json.loads((SOURCE_DIR / source_name).read_text())
        models = []
        for row in source['rows']:
            model_id = re.sub(r'[^a-z0-9]+', '-', row[0].lower()).strip('-')
            models.append({'id': model_id, 'name': row[0], 'values': row,
                           **source.get('details', {}).get(model_id, {})})
        return {'columns': source['columns'], 'models': models,
                'source_note': source['source_note'], 'source_files': source_files,
                **{key: source[key] for key in ('categories', 'glossary', 'groups') if key in source}}

    def check_model(model_id):
        if not any(m['id'] == model_id for m in catalog()['models']):
            raise ValueError('Unknown reference model')

    @contextmanager
    def store():
        db_override = os.environ.get(db_env)
        if not db_override and db_env == 'MTAPI_TTS_REFERENCES_DB':
            db_override = os.environ.get('MTAPI_AUDIO_REFERENCES_DB')
        path = Path(db_override or str(ROOT / 'mtapi-project' / 'data' / db_name)).expanduser()
        if not path.is_absolute():
            raise ValueError('Reference database path must be absolute')
        path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS notes (
                    model_id TEXT PRIMARY KEY, text TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY, model_id TEXT NOT NULL,
                    path TEXT NOT NULL, label TEXT NOT NULL, kind TEXT NOT NULL,
                    UNIQUE(model_id, path));
            ''')
            with db:
                yield db
        finally:
            db.close()

    def fail(exc):
        return JSONResponse({'ok': False, 'error': str(exc)})

    @router.get('')
    def index():
        try:
            return {'ok': True, **catalog()}
        except Exception as exc:
            return fail(exc)

    @router.get('/source/{name}')
    def source_file(name: str):
        allowed = {item['name'] for item in source_files}
        try:
            if name not in allowed:
                raise ValueError('Unknown source file')
            return FileResponse(SOURCE_DIR / name, filename=name,
                                headers={'X-Content-Type-Options': 'nosniff'})
        except Exception as exc:
            return fail(exc)

    @router.get('/model/{model_id}')
    def detail(model_id: str):
        try:
            check_model(model_id)
            with store() as db:
                note = db.execute('SELECT text, revision FROM notes WHERE model_id=?',
                                  (model_id,)).fetchone()
                files = [dict(r) for r in db.execute(
                    'SELECT * FROM files WHERE model_id=? ORDER BY id DESC', (model_id,))]
                for item in files:
                    item['tags'] = [r[0] for r in db.execute(
                        'SELECT model_id FROM files WHERE path=? ORDER BY model_id', (item['path'],))]
                    item['exists'] = Path(item['path']).is_file()
            return {'ok': True, 'note': dict(note) if note else {'text': '', 'revision': 0},
                    'files': files}
        except Exception as exc:
            return fail(exc)

    @router.post('/model/{model_id}/note')
    async def save_note(model_id: str, request: Request):
        try:
            check_model(model_id)
            body = await request.json()
            text = body.get('text')
            revision = body.get('revision')
            if not isinstance(text, str) or len(text) > 200000:
                raise ValueError('Notes must be text, at most 200,000 characters')
            if type(revision) is not int or revision < 0:
                raise ValueError('A valid note revision is required')
            with store() as db:
                db.execute('BEGIN IMMEDIATE')
                current = db.execute('SELECT revision FROM notes WHERE model_id=?', (model_id,)).fetchone()
                if (current['revision'] if current else 0) != revision:
                    raise ValueError('Notes changed in another window. Reload saved notes before saving; your draft is retained.')
                db.execute('INSERT INTO notes VALUES (?,?,?) ON CONFLICT(model_id) '
                           'DO UPDATE SET text=excluded.text, revision=excluded.revision',
                           (model_id, text, revision + 1))
            return {'ok': True, 'revision': revision + 1}
        except Exception as exc:
            return fail(exc)

    @router.post('/model/{model_id}/file')
    async def tag_file(model_id: str, request: Request):
        try:
            check_model(model_id)
            body = await request.json()
            raw = body.get('path')
            if not isinstance(raw, str) or not raw.strip():
                raise ValueError('Choose an existing file with an absolute path')
            path = Path(raw.strip()).expanduser()
            if not path.is_absolute():
                raise ValueError('File path must be absolute')
            path = path.resolve()
            if not path.is_file():
                raise ValueError('File does not exist or is not a regular file')
            label = body.get('label') or path.name
            kind = body.get('kind', 'output')
            if not isinstance(label, str) or len(label) > 300:
                raise ValueError('File label must be text, at most 300 characters')
            if kind not in ('output', 'reference', 'recipe', 'other'):
                raise ValueError('Unknown file kind')
            with store() as db:
                db.execute('INSERT INTO files(model_id,path,label,kind) VALUES (?,?,?,?) '
                           'ON CONFLICT(model_id,path) DO UPDATE SET label=excluded.label,kind=excluded.kind',
                           (model_id, str(path), label, kind))
            return {'ok': True}
        except Exception as exc:
            return fail(exc)

    @router.post('/model/{model_id}/file/{file_id}/untag')
    def untag_file(model_id: str, file_id: int):
        try:
            check_model(model_id)
            with store() as db:
                db.execute('DELETE FROM files WHERE id=? AND model_id=?', (file_id, model_id))
            return {'ok': True}
        except Exception as exc:
            return fail(exc)

    @router.get('/model/{model_id}/file/{file_id}')
    def download_file(model_id: str, file_id: int):
        try:
            check_model(model_id)
            with store() as db:
                row = db.execute('SELECT path FROM files WHERE id=? AND model_id=?',
                                 (file_id, model_id)).fetchone()
            if not row or not Path(row['path']).is_file():
                raise ValueError('Tagged file is no longer available')
            return FileResponse(row['path'], filename=Path(row['path']).name,
                                headers={'X-Content-Type-Options': 'nosniff'})
        except Exception as exc:
            return fail(exc)

    return router


router = create_reference_router(
    '/api/audio-references', ROOT / 'docs/reference/audio-models', 'audio-supertable.json',
    [{'name': name, 'label': label} for name, label in [
        ('audio-supertable.md', 'Merged Markdown'), ('audio-supertable.csv', 'Merged CSV'),
        ('audio-supertable.json', 'Merged JSON'), ('audio-supertable.html', 'Standalone table'),
        ('tts-supertable.md', 'TTS Markdown'), ('tts-supertable.csv', 'TTS CSV'),
        ('tts-supertable.json', 'TTS JSON'), ('tts-supertable.html', 'TTS Standalone table'),
        ('source.txt', 'Original research')]],
    'MTAPI_AUDIO_REFERENCES_DB', 'audio-references.sqlite3')
tts_router = create_reference_router(
    '/api/tts-references', ROOT / 'docs/reference/audio-models', 'audio-supertable.json',
    [{'name': name, 'label': label} for name, label in [
        ('tts-supertable.md', 'TTS Markdown'), ('tts-supertable.csv', 'TTS CSV'),
        ('tts-supertable.json', 'TTS JSON'), ('tts-supertable.html', 'Standalone table'),
        ('audio-supertable.md', 'Merged Markdown'), ('audio-supertable.csv', 'Merged CSV'),
        ('audio-supertable.json', 'Merged JSON'), ('audio-supertable.html', 'Merged Standalone table'),
        ('source.txt', 'Original research')]],
    'MTAPI_TTS_REFERENCES_DB', 'audio-references.sqlite3')
voicemod_router = create_reference_router(
    '/api/voicemod-references', ROOT / 'docs/reference/voicemod-models', 'voicemod-supertable.json',
    [{'name': name, 'label': label} for name, label in [
        ('voicemod-supertable.md', 'Voice Mod Markdown'), ('voicemod-supertable.csv', 'Voice Mod CSV'),
        ('voicemod-supertable.json', 'Voice Mod JSON'), ('voicemod-supertable.html', 'Standalone table'),
        ('source.txt', 'Voice Mod research')]],
    'MTAPI_VOICEMOD_REFERENCES_DB', 'voicemod-references.sqlite3')
listening_router = create_reference_router(
    '/api/listening-references', ROOT / 'docs/reference/listening-models', 'listening-supertable.json',
    [{'name': name, 'label': label} for name, label in [
        ('listening-supertable.md', 'Listening Markdown'), ('listening-supertable.csv', 'Listening CSV'),
        ('listening-supertable.json', 'Listening JSON'), ('sources.md', 'Primary source index')]],
    'MTAPI_LISTENING_REFERENCES_DB', 'listening-references.sqlite3')


def register(app):
    app.include_router(router)
    app.include_router(tts_router)
    app.include_router(voicemod_router)
    app.include_router(listening_router)
