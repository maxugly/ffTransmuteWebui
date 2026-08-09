import asyncio
from pathlib import Path
from app.media.thumbnails import _last_frame_ffmpeg_cmds

async def main():
    p = Path("/home/m/snc/img/gen/otherworld/MTEWT9Z8QRCSNZY8RRQK3NDQ60_melt.mp4")
    out = Path("/tmp/last.jpg")
    cmds = _last_frame_ffmpeg_cmds(p, out, scale="scale=480:-2", q=4)
    for cmd in cmds:
        print("Running:", " ".join(cmd))
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        print("Code:", proc.returncode)
        print("Error:", err.decode()[:1000])
        print("---")

asyncio.run(main())
