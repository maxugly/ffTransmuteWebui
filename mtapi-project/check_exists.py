import json
from pathlib import Path

media_root = Path.home() / ".cache" / "mtapi" / "media"
by_hash = media_root / "by_hash"

for h in list(by_hash.iterdir()):
    if not h.is_dir(): continue
    last_jpg = h / "last.jpg"
    if not last_jpg.exists():
        rp = h / "record.json"
        if rp.exists():
            data = json.loads(rp.read_text())
            for p in data.get("paths", []):
                if Path(p).exists():
                    print(f"Exists but missing last thumb: {p}")
                    exit(0)
print("None exist")
