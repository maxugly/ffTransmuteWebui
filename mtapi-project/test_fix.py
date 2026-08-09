import asyncio
from pathlib import Path
from app.media.open import open_media
from app.media.cache import _hash_dir, load_record
import time

async def dummy_probe(path):
    return {"ok": True, "frames": 100, "fps": 24.0, "duration": 4.16}

async def main():
    p = Path("/home/m/snc/img/gen/otherworld/MTEWT9Z8QRCSNZY8RRQK3NDQ60_melt.mp4")
    
    print("First load (should fail and set thumb_failed)...")
    t0 = time.time()
    await open_media(p, probe_fn=dummy_probe, ensure_thumbs_flag=True)
    t1 = time.time()
    print(f"First load took: {t1 - t0:.2f}s")
    
    from app.media.cache import resolve_hash
    content_hash, _ = await resolve_hash(p)
    rec = load_record(content_hash)
    print("Record thumb_failed:", rec.get("thumb_failed"))
    
    print("Second load (should be fast!)...")
    t0 = time.time()
    await open_media(p, probe_fn=dummy_probe, ensure_thumbs_flag=True)
    t1 = time.time()
    print(f"Second load took: {t1 - t0:.2f}s")

asyncio.run(main())
