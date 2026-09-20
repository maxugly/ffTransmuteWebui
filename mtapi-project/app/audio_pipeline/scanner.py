import os
import json
import hashlib
from typing import Dict, Any

from app.database.audio_db import get_db

class AudioScanner:
    def __init__(self, target_dir: str):
        self.target_dir = target_dir
        self.supported_exts = {'.wav', '.mp3', '.aif', '.aiff', '.flac'}
        
        # In a real implementation, we'd initialize the Essentia/Madmom 
        # models here so they stay in memory across the batch.
        
    def scan(self, yield_progress: bool = True):
        """Walk directory and process files iteratively."""
        for root, _, files in os.walk(self.target_dir):
            for file in files:
                ext = os.path.splitext(file)[1].lower()
                if ext in self.supported_exts:
                    filepath = os.path.join(root, file)
                    try:
                        self.process_file(filepath)
                        if yield_progress:
                            # Yield for UI progress bar
                            yield {"status": "scanned", "file": filepath}
                    except Exception as e:
                        if yield_progress:
                            yield {"status": "error", "file": filepath, "error": str(e)}

    def process_file(self, filepath: str):
        """Analyze file, write sidecars, and update DB."""
        # 1. Fast Hash (to skip files we already know)
        file_hash = self._quick_hash(filepath)
        
        # Check if already processed in DB
        with get_db() as db:
            if db.execute("SELECT id FROM tracks WHERE file_hash = ?", (file_hash,)).fetchone():
                return
        
        # 2. Heavy Extraction (Essentia / Madmom / Librosa)
        features = self._extract_features(filepath)
        
        # 3. Write Sidecars
        self._write_sidecars(filepath, features)
        
        # 4. Insert into SQLite
        self._upsert_track_to_db(filepath, file_hash, features)

    def _extract_features(self, filepath: str) -> Dict[str, Any]:
        """
        Placeholder for the actual heavy lifting.
        Will return a dictionary matching the JSON sidecar format.
        """
        # TODO: Implement Essentia RhythmExtractor2013 + KeyExtractor
        # TODO: Implement Madmom RNNBeatProcessor
        
        # Dummy data for now:
        return {
            "tempo": 128.0,
            "tempo_conf": 0.85,
            "key": "C minor",
            "key_strength": 0.9,
            "beats": [0.0, 0.5, 1.0, 1.5],
            "downbeats": [0.0, 2.0, 4.0],
            "onsets": [0.1, 0.25, 0.5]
        }

    def _write_sidecars(self, filepath: str, features: Dict[str, Any]):
        base, _ = os.path.splitext(filepath)
        json_path = f"{base}.json"
        mid_path = f"{base}.mid"
        
        # 1. Write JSON sidecar
        with open(json_path, 'w') as f:
            json.dump({
                "path": filepath,
                **features,
                "stems": {},
                "slices": []
            }, f, indent=2)
            
        # 2. Write MIDI sidecar
        self._write_midi_sidecar(mid_path, features)
        
    def _write_midi_sidecar(self, mid_path: str, features: Dict[str, Any]):
        """
        TODO: Use `mido` or `pretty_midi` to write a tempo map, 
        downbeat markers, and beat MIDI notes to the sidecar file.
        """
        pass

    def _upsert_track_to_db(self, filepath: str, file_hash: str, features: Dict[str, Any]):
        """Insert or update the SQLite tracks table."""
        with get_db() as db:
            db.execute("""
                INSERT INTO tracks (path, file_hash, status, tempo, tempo_conf, key_name, key_strength, raw_metadata)
                VALUES (?, ?, 'scanned', ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    file_hash=excluded.file_hash,
                    status='scanned',
                    tempo=excluded.tempo,
                    tempo_conf=excluded.tempo_conf,
                    key_name=excluded.key_name,
                    key_strength=excluded.key_strength,
                    raw_metadata=excluded.raw_metadata
            """, (
                filepath, file_hash, 
                features.get('tempo'), features.get('tempo_conf'),
                features.get('key'), features.get('key_strength'),
                json.dumps(features)
            ))

    def _quick_hash(self, filepath: str) -> str:
        """Hash just the first 1MB for speed on massive libraries."""
        hasher = hashlib.md5()
        with open(filepath, 'rb') as f:
            chunk = f.read(1024 * 1024)
            hasher.update(chunk)
        return hasher.hexdigest()
