import asyncio
from pathlib import Path
from app.media.thumbnails import extract_frame

async def main():
    p = Path("/home/m/snc/img/gen/otherworld/MTEWT9Z8QRCSNZY8RRQK3NDQ60_melt.mp4")
    out = Path("/tmp/last.jpg")
    if out.exists():
        out.unlink()
    ok = await extract_frame(p, out, "last")
    print(f"Result: {ok}")

asyncio.run(main())
