"""Supplemental research evidence. Never writes to media or model sidecars.

Imports are additive and content-addressed: revised source rows become separate
opinions. Explicit edits keep an audit copy. Matching is evaluated on read, so
newly scanned tags are usable without rescanning or duplicating research.
"""
import csv
import hashlib
import json
import re
import unicodedata
from pathlib import Path

from . import audio_db

SCHEMA = """
CREATE TABLE IF NOT EXISTS research_reference (
    id INTEGER PRIMARY KEY,
    content_hash TEXT UNIQUE NOT NULL,
    catalog TEXT NOT NULL,
    artist_match TEXT NOT NULL,
    title_match TEXT NOT NULL,
    album_match TEXT NOT NULL,
    payload TEXT NOT NULL,
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_research_track ON research_reference(artist_match,title_match);
CREATE TABLE IF NOT EXISTS research_link (
    media_id INTEGER NOT NULL REFERENCES media(id),
    reference_id INTEGER NOT NULL REFERENCES research_reference(id),
    included INTEGER NOT NULL,
    PRIMARY KEY(media_id, reference_id)
);
CREATE TABLE IF NOT EXISTS research_revision (
    id INTEGER PRIMARY KEY,
    reference_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    changed_at TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


def init_db():
    audio_db.init_db()
    with audio_db.get_db() as db, db:
        db.executescript(SCHEMA)


def normalize(value):
    text = unicodedata.normalize('NFKC', str(value or '')).casefold()
    return ' '.join(re.sub(r'[^\w]+', ' ', text).split())


def artist_key(value):
    key = normalize(value)
    return 'insane clown posse' if key in ('icp', 'i c p', 'insane clown posse') else key


def fields(payload):
    if not isinstance(payload, dict):
        raise ValueError('every research entry must be a JSON object')
    artist = artist_key(payload.get('artist'))
    title = normalize(payload.get('track_title') or payload.get('title'))
    album = normalize(payload.get('release_or_album') or payload.get('album'))
    if not artist or not title:
        raise ValueError('research entries require artist and track_title (or title)')
    # No key/mode/BPM interpretation here: a bare B stays bare B.
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, allow_nan=False)
    digest = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
    return digest, artist, title, album, encoded


def import_catalog(path):
    source = Path(path).expanduser()
    if not source.is_absolute():
        raise ValueError('catalog path must be absolute')
    if source.suffix.lower() == '.csv':
        with source.open(encoding='utf-8-sig', newline='') as stream:
            entries = list(csv.DictReader(stream))
    elif source.suffix.lower() == '.json':
        entries = json.loads(source.read_text(encoding='utf-8-sig'))
    else:
        raise ValueError('catalog must be JSON or CSV')
    if not isinstance(entries, list):
        raise ValueError('JSON catalog must be an array of research objects')
    prepared = [fields(entry) for entry in entries]  # validate before writing
    init_db()
    with audio_db.get_db() as db, db:
        before = db.total_changes
        db.executemany(
            'INSERT OR IGNORE INTO research_reference '
            '(content_hash,catalog,artist_match,title_match,album_match,payload) '
            'VALUES (?,?,?,?,?,?)',
            [(h, str(source), a, t, al, raw) for h, a, t, al, raw in prepared],
        )
        inserted = db.total_changes - before
        total = db.execute('SELECT COUNT(*) FROM research_reference').fetchone()[0]
    return {'inserted': inserted, 'existing': len(entries) - inserted, 'total': total}


def _entry(row, match=None):
    return {'id': row['id'], 'catalog': row['catalog'],
            'metadata': json.loads(row['payload']), 'match': match,
            'updated_at': row['updated_at']}


def comparison(path=None, search='', offset=0):
    init_db()
    with audio_db.get_db() as db, db:
        total = db.execute('SELECT COUNT(*) FROM research_reference').fetchone()[0]
        if not path:
            query = '%' + search.casefold() + '%'
            where = 'WHERE lower(payload) LIKE ?'
            count = db.execute('SELECT COUNT(*) FROM research_reference ' + where, (query,)).fetchone()[0]
            rows = db.execute('SELECT * FROM research_reference ' + where +
                              ' ORDER BY id LIMIT 50 OFFSET ?', (query, offset)).fetchall()
            return {'total': total, 'count': count, 'offset': offset,
                    'references': [_entry(row) for row in rows], 'media': None}
        media = db.execute('SELECT * FROM media WHERE path=?', (path,)).fetchone()
        if media is None:
            raise ValueError('no catalog row for this path')
        artist = artist_key(media['artist'])
        title = normalize(media['title'])
        album = normalize(media['album'])
        # Never guess identity from a filename or strip remix/version text.
        rows = db.execute(
            'SELECT * FROM research_reference WHERE (artist_match=? AND title_match=?) '
            'OR id IN (SELECT reference_id FROM research_link WHERE media_id=?) '
            "OR (? <> '' AND lower(payload) LIKE ?) ORDER BY id",
            (artist, title, media['id'], search, '%' + search.casefold() + '%'),
        ).fetchall()
        overrides = {r['reference_id']: r['included'] for r in db.execute(
            'SELECT reference_id,included FROM research_link WHERE media_id=?', (media['id'],))}
        versions = {normalize(json.loads(r['payload']).get('recording_version'))
                    for r in rows if album and r['album_match'] == album}
        references = []
        for row in rows:
            override = overrides.get(row['id'])
            if override is not None:
                match = 'manual' if override else 'excluded'
            elif artist and title and album and row['artist_match'] == artist and row['title_match'] == title and row['album_match'] == album and len(versions) <= 1:
                match = 'artist / title / release tags (recording unverified)'
            else:
                match = 'candidate — release or recording needs review'
            references.append(_entry(row, match))
        return {'total': total, 'references': references, 'media': dict(media)}


def set_link(path, reference_id, included):
    init_db()
    with audio_db.get_db() as db, db:
        media = db.execute('SELECT id FROM media WHERE path=?', (path,)).fetchone()
        ref = db.execute('SELECT id FROM research_reference WHERE id=?', (reference_id,)).fetchone()
        if media is None or ref is None:
            raise ValueError('unknown media path or reference ID')
        db.execute('INSERT INTO research_link VALUES (?,?,?) '
                   'ON CONFLICT(media_id,reference_id) DO UPDATE SET included=excluded.included',
                   (media['id'], reference_id, int(included)))


def update_entry(reference_id, payload):
    h, a, t, al, encoded = fields(payload)
    init_db()
    with audio_db.get_db() as db, db:
        row = db.execute('SELECT * FROM research_reference WHERE id=?', (reference_id,)).fetchone()
        if row is None:
            raise ValueError('unknown reference ID')
        duplicate = db.execute('SELECT id FROM research_reference WHERE content_hash=? AND id<>?',
                               (h, reference_id)).fetchone()
        if duplicate:
            raise ValueError('identical evidence already exists; edit that record instead')
        if encoded == row['payload']:
            return
        db.execute('INSERT INTO research_revision(reference_id,payload) VALUES (?,?)',
                   (reference_id, row['payload']))
        db.execute('UPDATE research_reference SET content_hash=?,artist_match=?,title_match=?, '
                   'album_match=?,payload=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
                   (h, a, t, al, encoded, reference_id))
