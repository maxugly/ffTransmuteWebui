import asyncio
from pathlib import Path
from app.media.thumbnails import extract_frame

async def main():
    p = Path("/home/m/.cache/mtapi/media/by_hash/test_image.jpg")
    p.parent.mkdir(parents=True, exist_ok=True)
    # create a dummy image
    import sys
    import subprocess
    subprocess.run(["ffmpeg", "-f", "lavfi", "-i", "color=c=red:s=100x100", "-frames:v", "1", "-y", str(p)])
    
    out = Path("/tmp/last.jpg")
    ok = await extract_frame(p, out, "last")
    print(f"Result: {ok}")

asyncio.run(main())
