import asyncio
from pathlib import Path
from app.media.thumbnails import extract_frame

async def main():
    p = Path("/home/m/2_0002.mp4")
    out = Path("/tmp/last.jpg")
    ok = await extract_frame(p, out, "last")
    print(f"Result: {ok}")

asyncio.run(main())
