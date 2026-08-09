import asyncio
import time
from pathlib import Path
from app.media.open import open_media

# Dummy probe function
async def dummy_probe(path):
    return {"ok": True, "frames": 100, "fps": 24.0, "duration": 4.16}

async def main():
    p = Path("/home/m/snc/vid/ppc/1/grok-video-940336e4-3888-4069-a919-ba14c7e4212a.mp4")
    print("First load...")
    t0 = time.time()
    res1 = await open_media(p, probe_fn=dummy_probe, ensure_thumbs_flag=True)
    t1 = time.time()
    print(f"First load time: {t1 - t0:.2f}s, was_cached: {res1.get('cached')}")

    print("Second load...")
    t0 = time.time()
    res2 = await open_media(p, probe_fn=dummy_probe, ensure_thumbs_flag=True)
    t1 = time.time()
    print(f"Second load time: {t1 - t0:.2f}s, was_cached: {res2.get('cached')}")

asyncio.run(main())
