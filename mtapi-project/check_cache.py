import json
from pathlib import Path

media_root = Path.home() / ".cache" / "mtapi" / "media"
by_hash = media_root / "by_hash"

if not by_hash.exists():
    print("No cache")
    exit(0)

hashes = list(by_hash.iterdir())
print(f"Total hashes: {len(hashes)}")

ver1 = 0
ver2 = 0
no_ver = 0
no_thumb = 0

for h in hashes:
    if not h.is_dir():
        continue
    last_jpg = h / "last.jpg"
    ver_path = h / "last.extract_v"
    if not last_jpg.exists():
        no_thumb += 1
        continue
    if not ver_path.exists():
        no_ver += 1
        continue
    
    txt = ver_path.read_text().strip()
    if txt == "1":
        ver1 += 1
    elif txt == "2":
        ver2 += 1
    else:
        print(f"Unknown version: {txt}")

print(f"Thumbs OK with v2: {ver2}")
print(f"Thumbs with v1: {ver1}")
print(f"Thumbs with no version: {no_ver}")
print(f"Missing last thumb: {no_thumb}")
