import json
from pathlib import Path

media_root = Path.home() / ".cache" / "mtapi" / "media"
by_hash = media_root / "by_hash"

hashes = list(by_hash.iterdir())
for h in hashes[:]:
    if not h.is_dir():
        continue
    last_jpg = h / "last.jpg"
    if not last_jpg.exists():
        record_path = h / "record.json"
        if record_path.exists():
            data = json.loads(record_path.read_text())
            paths = data.get("paths", [])
            print(f"Missing last thumb for: {paths[0] if paths else 'Unknown'}")
