import sqlite3
import json
import os
from contextlib import contextmanager

DB_PATH = os.path.join(os.path.expanduser("~"), ".ffTransmute", "audio_catalog.db")

SCHEMA = """
-- Core tracks (The Phase 1 source files)
CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,      -- Absolute path to original file
    file_hash TEXT,                 -- To prevent re-scanning
    status TEXT DEFAULT 'pending',  -- 'pending', 'scanned', 'separated', 'sliced', 'error'
    
    -- Extracted global metadata
    tempo REAL,                     -- e.g., 128.32
    tempo_conf REAL,                -- e.g., 0.92
    key_name TEXT,                  -- e.g., 'G minor'
    key_strength REAL,
    duration REAL,
    
    -- Full JSON dump for flexible querying/fallback
    raw_metadata JSON,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stems (Phase 2 outputs from Demucs)
CREATE TABLE IF NOT EXISTS stems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    stem_type TEXT NOT NULL,        -- 'drums', 'bass', 'vocals', 'other'
    path TEXT UNIQUE NOT NULL       -- Absolute path to e.g., /stems/123/drums.wav
);

-- Slices (Phase 3 outputs from Auburn/Librosa/Madmom)
CREATE TABLE IF NOT EXISTS slices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER REFERENCES tracks(id) ON DELETE CASCADE,
    stem_id INTEGER REFERENCES stems(id) ON DELETE CASCADE, -- Null if sliced from master
    slice_type TEXT NOT NULL,       -- 'kick', 'snare', 'loop', 'melody_midi'
    
    start_time REAL NOT NULL,       -- In seconds
    end_time REAL,                  -- In seconds
    path TEXT UNIQUE NOT NULL,      -- Absolute path to the exported slice
    
    -- Store slice-specific data (e.g. MIDI note, confidence, loudness)
    metadata JSON 
);

CREATE INDEX IF NOT EXISTS idx_tracks_bpm ON tracks(tempo);
CREATE INDEX IF NOT EXISTS idx_tracks_key ON tracks(key_name);
CREATE INDEX IF NOT EXISTS idx_slices_type ON slices(slice_type);
"""

@contextmanager
def get_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.commit()
        conn.close()

def init_db():
    with get_db() as db:
        db.executescript(SCHEMA)
