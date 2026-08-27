"""
datamosh.sh logic implemented directly in Python to support advanced creative controls:
- Melt (continuous motion-vector averaged smear)
- Classic (no-keyframe mosh at cuts)
- Visual Hijack (inject an image/frame at a start frame range and recover at end frame)
- Residual Destruct (zero out DCT error correction coefficients to force pixel bleed)
- Motion Vector Hack (multiply or drift vectors in a custom frame range)
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from pydantic import BaseModel, Field

from ...contract import OperationResult, OperationSpec, register
from ...output_dir_ctx import get_output_dir
from ...shell import run_command, BIN_DIR

CUSTOM_GLITCH_JS = str(BIN_DIR / "custom_glitch.js")
NO_KEYFRAME_JS = str(BIN_DIR.parent.parent / "no_keyframe.js")
MELT_JS = str(BIN_DIR.parent.parent / "melt.js")

DECODER_ERROR_PATTERNS = (
    "invalid cbp", "corrupt", "conceal", "concealing",
    "out of range", "numerical result",
)


async def _execute_mosh_pipeline(
    operation: str,
    input_path: str,
    output_path: str,
    glitch_mode: int,          # 0=melt, 1=classic, 2=destruct, 3=mv_hack, 4=freeze_mosh
    glitch_params: list[int],  # raw params to pass to the JS glitch script
    inject_mode: str | None = None,
    inject_image_path: str | None = None,
    inject_frame_num: int = 0,
    start_frame: int = 1,
    end_frame: int = 999999,
    dry_run: bool = False,
) -> OperationResult:
    from ...pathutil import unique_output_path
    from ...probe import probe_duration
    from ... import job_control

    mode_names = {0: "melt", 1: "classic", 2: "destruct", 3: "mv_hack", 4: "freeze_mosh"}
    cmd = f"datamosh {mode_names.get(glitch_mode, str(glitch_mode))} params={glitch_params} -> {output_path}"
    if dry_run:
        return OperationResult(ok=True, operation=operation, output_path=output_path, dry_run=True, command=cmd, stdout=f"Command: {cmd}\n")

    # Validate input file
    if not os.path.exists(input_path):
        return OperationResult(
            ok=False,
            operation=operation,
            error=f"Input file not found: {input_path}"
        )

    # Never overwrite a previous mosh result at the same path
    output_path = str(unique_output_path(output_path))

    cwd = os.path.dirname(os.path.abspath(input_path))
    
    # Create temp directory for processing intermediate raw videos
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_prepped = os.path.join(tmpdir, "prepped.m2v")
        tmp_glitched = os.path.join(tmpdir, "glitched.m2v")
        
        # Probe original video characteristics
        res_code, res_out, res_err = await run_command([
            "ffprobe", "-v", "error", "-select_streams", "v:0", 
            "-show_entries", "stream=width,height,r_frame_rate", 
            "-of", "csv=s=x:p=0", input_path
        ])
        if res_code != 0:
            return OperationResult(
                ok=False,
                operation=operation,
                error=f"Failed to probe video characteristics: {res_err.strip()}"
            )

        parts = res_out.strip().split('x')
        if len(parts) < 3:
            w, h, fps = "1920", "1080", "30"
        else:
            w, h, fps = parts[0], parts[1], parts[2]

        # Calculate frame duration in seconds
        try:
            if '/' in fps:
                num, den = map(float, fps.split('/'))
                fps_val = num / den
            else:
                fps_val = float(fps)
            frame_dur = 1.0 / fps_val
        except Exception:
            frame_dur = 0.033  # fallback to 30fps

        # Probe if video has audio
        audio_code, audio_out, audio_err = await run_command([
            "ffprobe", "-v", "error", "-select_streams", "a", 
            "-show_entries", "stream=codec_type", "-of", "csv=p=0", input_path
        ])
        has_audio = audio_out.strip() == "audio"

        # Determine source video for ffgac/ffedit step
        source_video = input_path
        tmp_part1 = None
        tmp_part2 = None

        # Step 0: Handle Visual Hijack splitting & image prepending
        if inject_mode in ("file", "frame"):
            job_control.check_cancelled()
            inject_image = inject_image_path
            
            # If extracting a frame from the input video as the source image
            if inject_mode == "frame":
                tmp_extracted = os.path.join(tmpdir, "extracted.png")
                extract_code, extract_out, extract_err = await run_command([
                    "ffmpeg", "-i", input_path, 
                    "-vf", f"select=eq(n\\,{inject_frame_num})", 
                    "-vframes", "1", "-y", tmp_extracted
                ])
                if extract_code != 0:
                    return OperationResult(
                        ok=False,
                        operation=operation,
                        error=f"Failed to extract frame {inject_frame_num} for hijack: {extract_err.strip()}"
                    )
                inject_image = tmp_extracted

            if not inject_image or not os.path.exists(inject_image):
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"Injected image not found: {inject_image}"
                )

            # Create a 1-frame video from the image
            tmp_img_vid = os.path.join(tmpdir, "img_vid.mp4")
            img_code, img_out, img_err = await run_command([
                "ffmpeg", "-loop", "1", "-i", inject_image, 
                "-t", f"{frame_dur * 1.5}", # ensure it covers at least 1 frame
                "-vf", f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1",
                "-r", fps, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", tmp_img_vid
            ])
            if img_code != 0:
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"Failed to encode image frame: {img_err.strip()}"
                )

            if start_frame > 1:
                # Range-based Mosh! We slice the video into Part 1 (pre-mosh) and Part 2 (mosh)
                remaining_frames = end_frame - start_frame + 1
                if remaining_frames < 3:
                    return OperationResult(
                        ok=False,
                        operation=operation,
                        error=f"Hijack point too close to end (frame {start_frame}, "
                              f"only ~{remaining_frames} frames after). Need at least 3 frames "
                              f"for the mosh to produce output."
                    )
                split_time = start_frame * frame_dur
                
                # Part 1: Start of video up to start_frame
                tmp_part1 = os.path.join(tmpdir, "part1.mp4")
                p1_code, p1_out, p1_err = await run_command([
                    "ffmpeg", "-i", input_path, "-t", f"{split_time}", 
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", "-y", tmp_part1
                ])
                if p1_code != 0:
                    p1_code, p1_out, p1_err = await run_command([
                        "ffmpeg", "-i", input_path, "-t", f"{split_time}", 
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", tmp_part1
                    ])
                    if p1_code != 0:
                        return OperationResult(
                            ok=False,
                            operation=operation,
                            error=f"Failed to slice Part 1 (frames 1-{start_frame}): {p1_err.strip()}"
                        )

                # Part 2: Rest of video starting from start_frame
                tmp_part2 = os.path.join(tmpdir, "part2.mp4")
                p2_code, p2_out, p2_err = await run_command([
                    "ffmpeg", "-ss", f"{split_time}", "-i", input_path, 
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", "-y", tmp_part2
                ])
                if p2_code != 0:
                    p2_code, p2_out, p2_err = await run_command([
                        "ffmpeg", "-ss", f"{split_time}", "-i", input_path, 
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", tmp_part2
                    ])
                    if p2_code != 0:
                        return OperationResult(
                            ok=False,
                            operation=operation,
                            error=f"Failed to slice Part 2 (frames {start_frame}+): {p2_err.strip()}"
                        )

                # Replace the first frame of Part 2 with the injected image.
                # Skip the first frame of Part 2, then concat image + remainder.
                # If Part 2 is too short (hijack near video end), skip the concat
                # and use the image video directly.
                p2dur = await probe_duration(tmp_part2)
                if p2dur > frame_dur * 1.1:
                    tmp_part2_skipped = os.path.join(tmpdir, "part2_skipped.mp4")
                    skip_code, skip_out, skip_err = await run_command([
                        "ffmpeg", "-ss", f"{frame_dur}", "-i", tmp_part2,
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "copy", "-y", tmp_part2_skipped
                    ])
                    if skip_code != 0:
                        skip_code, skip_out, skip_err = await run_command([
                            "ffmpeg", "-ss", f"{frame_dur}", "-i", tmp_part2,
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", tmp_part2_skipped
                        ])
                    if skip_code == 0:
                        # Concat image + skipped Part 2
                        tmp_concat = os.path.join(tmpdir, "concat.mp4")
                        concat_code, concat_out, concat_err = await run_command([
                            "ffmpeg", "-i", tmp_img_vid, "-i", tmp_part2_skipped,
                            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
                            "-map", "[outv]", "-map", "1:a?", "-c:v", "libx264", "-c:a", "copy", "-y", tmp_concat
                        ])
                        if concat_code != 0:
                            concat_code, concat_out, concat_err = await run_command([
                                "ffmpeg", "-i", tmp_img_vid, "-i", tmp_part2_skipped,
                                "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
                                "-map", "[outv]", "-an", "-c:v", "libx264", "-y", tmp_concat
                            ])
                            if concat_code != 0:
                                return OperationResult(
                                    ok=False,
                                    operation=operation,
                                    error=f"Concatenation of image and Part 2 failed: {concat_err.strip()}"
                                )
                        source_video = tmp_concat
                    else:
                        source_video = tmp_img_vid  # skip failed, Part 2 unusable
                else:
                    source_video = tmp_img_vid  # Part 2 too short, use image only
            else:
                # Prepend at start (start_frame <= 1)
                tmp_concat = os.path.join(tmpdir, "concat.mp4")
                concat_code, concat_out, concat_err = await run_command([
                    "ffmpeg", "-i", tmp_img_vid, "-ss", f"{frame_dur}", "-i", input_path,
                    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
                    "-map", "[outv]", "-map", "1:a?", "-c:v", "libx264", "-c:a", "copy", "-y", tmp_concat
                ])
                if concat_code != 0:
                    concat_code, concat_out, concat_err = await run_command([
                        "ffmpeg", "-i", tmp_img_vid, "-ss", f"{frame_dur}", "-i", input_path,
                        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[outv]",
                        "-map", "[outv]", "-an", "-c:v", "libx264", "-y", tmp_concat
                    ])
                source_video = tmp_concat

        # Step 1: Transcode source stream to raw MPEG-2 using ffgac
        ffgac_cmd = [
            "ffgac", "-i", source_video, "-an", "-vcodec", "mpeg2video", 
            "-mpv_flags", "+nopimb+forcemv", "-qscale:v", "1", 
            "-intra_penalty", "1000000000",
            "-g", "max", "-sc_threshold", "max"
        ]
        # Suppress keyframes for classic, destruct, mv_hack, and freeze modes
        if glitch_mode != 0:
            ffgac_cmd.extend(["-pict_type_script", NO_KEYFRAME_JS])
            
        ffgac_cmd.extend(["-f", "rawvideo", "-y", tmp_prepped])

        job_control.check_cancelled()
        code_ffgac, out_ffgac, err_ffgac = await run_command(ffgac_cmd, cwd=cwd)
        if code_ffgac != 0:
            return OperationResult(
                ok=False,
                operation=operation,
                error=f"ffgac transcode failed: {err_ffgac.strip()}"
            )
        job_control.check_cancelled()

        # Step 2: Edit/Glitch the raw stream using ffedit
        if glitch_mode == 0:
            # Melt Mode
            script_path = MELT_JS
            params_str = f"[{glitch_params[0]}, {glitch_params[1]}, {glitch_params[2]}]"
            ffedit_cmd = [
                "ffedit", "-i", tmp_prepped, "-s", script_path, 
                "-sp", params_str, "-o", tmp_glitched, "-y"
            ]
            code_ffedit, out_ffedit, err_ffedit = await run_command(ffedit_cmd, cwd=cwd)
            if code_ffedit != 0:
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"ffedit glitch failed: {err_ffedit.strip()}"
                )
        elif glitch_mode == 1:
            # Classic Mode (suppressed in ffgac, no JS script edit needed)
            shutil.copy2(tmp_prepped, tmp_glitched)
            code_ffedit, out_ffedit, err_ffedit = 0, "", ""
        elif glitch_mode == 4:
            # Freeze Mosh: Two passes of ffedit to avoid mutual exclusivity of 'mb' and 'mv'
            tmp_mid = os.path.join(tmpdir, "mid_freeze.m2v")
            
            # Pass 1: Clear residuals (mode 2)
            params1 = f"[2, {glitch_params[0]}, {glitch_params[1]}, 100, 0, 0]"
            ffedit_cmd1 = [
                "ffedit", "-i", tmp_prepped, "-s", CUSTOM_GLITCH_JS,
                "-sp", params1, "-o", tmp_mid, "-y"
            ]
            code_ffedit1, out_ffedit1, err_ffedit1 = await run_command(ffedit_cmd1, cwd=cwd)
            if code_ffedit1 != 0:
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"ffedit freeze pass 1 (residual clear) failed: {err_ffedit1.strip()}"
                )
                
            # Pass 2: Zero out motion vectors (mode 3 with multiplier 0)
            params2 = f"[3, {glitch_params[0]}, {glitch_params[1]}, 0, 0, 0]"
            ffedit_cmd2 = [
                "ffedit", "-i", tmp_mid, "-s", CUSTOM_GLITCH_JS,
                "-sp", params2, "-o", tmp_glitched, "-y"
            ]
            code_ffedit2, out_ffedit2, err_ffedit2 = await run_command(ffedit_cmd2, cwd=cwd)
            if code_ffedit2 != 0:
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"ffedit freeze pass 2 (vector zero) failed: {err_ffedit2.strip()}"
                )
                
            code_ffedit, out_ffedit, err_ffedit = 0, f"Pass 1:\n{out_ffedit1}\nPass 2:\n{out_ffedit2}", f"Pass 1:\n{err_ffedit1}\nPass 2:\n{err_ffedit2}"
        else:
            # Mode 2 or 3
            script_path = CUSTOM_GLITCH_JS
            params_str = f"[{glitch_mode}, {glitch_params[0]}, {glitch_params[1]}, {glitch_params[2]}, {glitch_params[3]}, {glitch_params[4]}]"
            ffedit_cmd = [
                "ffedit", "-i", tmp_prepped, "-s", script_path, 
                "-sp", params_str, "-o", tmp_glitched, "-y"
            ]
            code_ffedit, out_ffedit, err_ffedit = await run_command(ffedit_cmd, cwd=cwd)
            if code_ffedit != 0:
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"ffedit glitch failed: {err_ffedit.strip()}"
                )

        job_control.check_cancelled()

        # Step 3: Re-encode raw video back to intermediate MP4
        tmp_mp4_part2 = os.path.join(tmpdir, "mp4_part2.mp4")
        ffmpeg_prep_cmd = [
            "ffmpeg", "-i", tmp_glitched, "-i", source_video, 
            "-map", "0:v", "-map", "1:a?", "-c:v", "libx264", 
            "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-y", tmp_mp4_part2
        ]
        code_prep, out_prep, err_prep = await run_command(ffmpeg_prep_cmd, cwd=cwd)
        if code_prep != 0:
            return OperationResult(
                ok=False,
                operation=operation,
                error=f"ffmpeg intermediate re-encoding failed: {err_prep.strip()}"
            )

        # Step 4: Assemble final output
        if start_frame > 1 and tmp_part1:
            # We have Part 1 (clean) and Part 2 (glitched). Concatenate them.
            if has_audio:
                concat_filter = "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[outv][outa]"
                ffmpeg_cmd = [
                    "ffmpeg", "-i", tmp_part1, "-i", tmp_mp4_part2,
                    "-filter_complex", concat_filter,
                    "-map", "[outv]", "-map", "[outa]",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", output_path
                ]
            else:
                concat_filter = "[0:v][1:v]concat=n=2:v=1:a=0[outv]"
                ffmpeg_cmd = [
                    "ffmpeg", "-i", tmp_part1, "-i", tmp_mp4_part2,
                    "-filter_complex", concat_filter,
                    "-map", "[outv]",
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", "-y", output_path
                ]
            
            code_ffmpeg, out_ffmpeg, err_ffmpeg = await run_command(ffmpeg_cmd, cwd=cwd)
            if code_ffmpeg != 0:
                return OperationResult(
                    ok=False,
                    operation=operation,
                    error=f"ffmpeg final merge failed: {err_ffmpeg.strip()}"
                )
        else:
            # Prepended at start, just move the intermediate MP4 to output
            shutil.copy2(tmp_mp4_part2, output_path)
            out_ffmpeg, err_ffmpeg = "", ""

        return OperationResult(
            ok=True,
            operation=operation,
            output_path=output_path,
            command=f"ffgac ... && ffedit ... && ffmpeg ...",
            stdout=f"ffgac:\n{out_ffgac}\nffedit:\n{out_ffedit}\nffmpeg:\n{out_ffmpeg}",
            stderr=f"ffgac:\n{err_ffgac}\nffedit:\n{err_ffedit}\nffmpeg:\n{err_ffmpeg}"
        )


async def _probe_has_audio(path: str) -> bool:
    """True only when ffprobe reports an actual audio stream (not merely exit 0)."""
    code, out, _ = await run_command([
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
    ])
    return code == 0 and "audio" in out.strip().lower()


async def _probe_has_video(path: str) -> bool:
    """True only when ffprobe reports an actual video stream (not merely exit 0)."""
    code, out, _ = await run_command([
        "ffprobe", "-v", "error", "-select_streams", "v",
        "-show_entries", "stream=codec_type", "-of", "csv=p=0", path,
    ])
    return code == 0 and "video" in out.strip().lower()


async def _slice_segment(
    input_path: str,
    output_path: str,
    *,
    start_time: float | None = None,
    duration: float | None = None,
    keep_audio: bool = False,
) -> tuple[bool, str]:
    """Encode a timeline slice. Prefer re-encoded AAC audio; fall back to -an."""
    cmd = ["ffmpeg", "-y"]
    if start_time is not None and start_time > 0:
        cmd.extend(["-ss", f"{start_time}"])
    cmd.extend(["-i", input_path])
    if duration is not None:
        cmd.extend(["-t", f"{duration}"])
    cmd.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p"])
    if keep_audio:
        cmd.extend(["-c:a", "aac", "-b:a", "192k", output_path])
    else:
        cmd.extend(["-an", output_path])

    code, _, err = await run_command(cmd)
    if code == 0:
        return True, ""

    if keep_audio:
        # Retry without audio (source may lack a usable track despite probe)
        cmd_an = ["ffmpeg", "-y"]
        if start_time is not None and start_time > 0:
            cmd_an.extend(["-ss", f"{start_time}"])
        cmd_an.extend(["-i", input_path])
        if duration is not None:
            cmd_an.extend(["-t", f"{duration}"])
        cmd_an.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", output_path])
        code, _, err = await run_command(cmd_an)
        if code == 0:
            return True, ""

    return False, err.strip()


async def _trim_and_mosh(
    operation: str,
    input_path: str,
    output_path: str,
    start_frame: int,
    end_frame: int,
    glitch_mode: int,
    glitch_params: list[int],
    dry_run: bool = False,
) -> OperationResult:
    """Trim a portion of the video, mosh it, then reassemble with clean bookends."""
    import json
    from ...pathutil import unique_output_path
    from ... import job_control

    mode_names = {0: "melt", 1: "classic", 2: "destruct", 3: "mv_hack", 4: "freeze_mosh"}
    cmd = f"datamosh {mode_names.get(glitch_mode, str(glitch_mode))} start={start_frame} end={end_frame} params={glitch_params} -> {output_path}"
    if dry_run:
        return OperationResult(ok=True, operation=operation, output_path=output_path, dry_run=True, command=cmd, stdout=f"Command: {cmd}\n")

    # If no trimming needed, delegate directly to the main pipeline
    if start_frame <= 1 and end_frame >= 999999:
        return await _execute_mosh_pipeline(
            operation, input_path, output_path,
            glitch_mode=glitch_mode,
            glitch_params=glitch_params,
            dry_run=dry_run,
        )

    # Probe FPS
    code, out, err = await run_command([
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_streams", "-select_streams", "v:0", input_path,
    ])
    if code != 0:
        return OperationResult(ok=False, operation=operation, error=f"ffprobe failed: {err.strip()}")
    info = json.loads(out)
    stream = info["streams"][0] if info.get("streams") else {}
    fps_parts = stream.get("avg_frame_rate", "30/1").split("/")
    fps = float(fps_parts[0]) / float(fps_parts[1]) if len(fps_parts) == 2 else 30.0
    frame_dur = 1.0 / fps

    start_time = (start_frame - 1) * frame_dur
    end_time = end_frame * frame_dur

    # Must check stream content — ffprobe often exits 0 with empty output when
    # no audio stream exists, which previously forced a broken a=1 concat.
    has_audio = await _probe_has_audio(input_path)

    tmpdir = tempfile.mkdtemp(prefix="mtapi_trim_")
    try:
        job_control.check_cancelled()
        # Part A: 0 to start_frame (untouched).  At frame 1 this is a
        # zero-length segment; skip it so concat never sees an empty input.
        tmp_a = None
        if start_time > 0:
            tmp_a = os.path.join(tmpdir, "partA.mp4")
            ok_a, err_a = await _slice_segment(
                input_path, tmp_a, duration=start_time, keep_audio=has_audio,
            )
            if not ok_a:
                return OperationResult(ok=False, operation=operation,
                                       error=f"Part A slice failed: {err_a}")

        job_control.check_cancelled()
        # Part B: start_frame to end_frame (to be moshed)
        tmp_b = os.path.join(tmpdir, "partB.mp4")
        dur_b = end_time - start_time
        ok_b, err_b = await _slice_segment(
            input_path, tmp_b,
            start_time=start_time, duration=dur_b, keep_audio=has_audio,
        )
        if not ok_b:
            return OperationResult(ok=False, operation=operation,
                                   error=f"Part B slice failed: {err_b}")

        job_control.check_cancelled()
        # Mosh part B
        tmp_moshed = os.path.join(tmpdir, "partB_moshed.mp4")
        result = await _execute_mosh_pipeline(
            operation, tmp_b, tmp_moshed,
            glitch_mode=glitch_mode,
            glitch_params=glitch_params,
            dry_run=dry_run,
        )
        if not result.ok:
            return result

        job_control.check_cancelled()
        # Part C: end_frame to end (untouched)
        tmp_c = os.path.join(tmpdir, "partC.mp4")
        ok_c, _ = await _slice_segment(
            input_path, tmp_c, start_time=end_time, keep_audio=has_audio,
        )
        has_c = (
            ok_c
            and os.path.exists(tmp_c)
            and os.path.getsize(tmp_c) > 1000
            and await _probe_has_video(tmp_c)
        )

        # Concat the non-empty segments in timeline order.  Part A is absent
        # when start_frame=1, so input indexes must be generated dynamically.
        # OperationResult.output_path is str — unique_output_path returns Path.
        output_path = str(unique_output_path(output_path))
        segments: list[str] = []
        if tmp_a is not None:
            segments.append(tmp_a)
        segments.append(tmp_moshed)
        if has_c:
            segments.append(tmp_c)

        # Only request audio concat when *every* segment actually has audio.
        # Moshed B may drop audio even when the source had it.
        segment_audio = [await _probe_has_audio(seg) for seg in segments]
        use_audio = bool(segment_audio) and all(segment_audio)

        # Defensive: concat=n=N needs a real [i:v] per input or ffmpeg dies
        # with "matches no streams". Drop any segment that lost its video
        # stream (e.g. a zero-duration tail from end_time at/after the last
        # source frame — common on kdenlive exports mosh-covered to the end).
        segments = [s for s in segments if await _probe_has_video(s)]
        if not segments:
            return OperationResult(ok=False, operation=operation,
                                   error="Concat failed: no video segments to join")

        inputs: list[str] = []
        video_labels: list[str] = []
        for index, segment in enumerate(segments):
            inputs.extend(["-i", segment])
            video_labels.append(f"[{index}:v]")

        n = len(segments)
        if use_audio:
            audio_labels = [f"[{index}:a]" for index in range(n)]
            # concat expects interleaved v/a per segment: [0:v][0:a][1:v][1:a]...
            interleaved = "".join(
                f"[{i}:v][{i}:a]" for i in range(n)
            )
            filter_str = f"{interleaved}concat=n={n}:v=1:a=1[outv][outa]"
        else:
            filter_str = f"{''.join(video_labels)}concat=n={n}:v=1:a=0[outv]"

        concat_cmd = ["ffmpeg", "-y", *inputs, "-filter_complex", filter_str,
                      "-map", "[outv]"]
        if use_audio:
            concat_cmd.extend(["-map", "[outa]", "-c:a", "aac"])
        else:
            concat_cmd.append("-an")
        concat_cmd.extend(["-c:v", "libx264", "-pix_fmt", "yuv420p", output_path])

        code_concat, out_concat, err_concat = await run_command(concat_cmd)

        # Last-resort video-only retry (e.g. mismatched sample rates / dropped tracks)
        if code_concat != 0 and use_audio:
            filter_v = f"{''.join(video_labels)}concat=n={n}:v=1:a=0[outv]"
            concat_cmd = [
                "ffmpeg", "-y", *inputs, "-filter_complex", filter_v,
                "-map", "[outv]", "-an",
                "-c:v", "libx264", "-pix_fmt", "yuv420p", output_path,
            ]
            code_concat, out_concat, err_concat = await run_command(concat_cmd)

        if code_concat != 0:
            return OperationResult(ok=False, operation=operation,
                                   error=f"Concat failed: {err_concat.strip()}")

        return OperationResult(
            ok=True,
            operation=operation,
            output_path=output_path,
            command=f"trim({start_frame}-{end_frame}) + mosh + concat",
            stdout=out_concat,
            stderr=err_concat,
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ─── Visual Hijack — Motion-Vector Payload Injection ──────────────────────────
#
# Instead of splicing an image into the video and then destroying DCT residuals
# (which produces invalid block states and green decoder-error frames), this
# pipeline performs a clean motion-vector transfer:
#
#   SOURCE → export MVs →  source_mv.json
#   IMAGE  → repeat N×   →  payload.m2v  (all P-frames, zero residuals)
#   payload.m2v + source_mv.json → ffedit -a → hijacked.m2v
#   hijacked.m2v → re-encode → mp4
#   clean_source[0:start] + hijacked_mp4 + clean_source[end+1:] → final mp4
#
# The payload image becomes the visual content while the source video's
# motion vectors drive the prediction chain.


async def _probe_source_info(input_path: str) -> dict:
    """Probe width, height, fps, frame count, and audio presence."""
    from ...probe import probe_fps, probe_frame_count

    code, out, _ = await run_command([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate",
        "-of", "csv=s=x:p=0", input_path,
    ])
    w, h, fps = 1920, 1080, 30
    if code == 0 and out.strip():
        parts = out.strip().split("x")
        if len(parts) >= 3:
            w, h = int(parts[0]), int(parts[1])
            try:
                if "/" in parts[2]:
                    num, den = map(float, parts[2].split("/"))
                    fps = num / den if den else 30
                else:
                    fps = float(parts[2])
            except (ValueError, ZeroDivisionError):
                pass

    frame_count = await probe_frame_count(input_path, default=0)
    if frame_count <= 0:
        frame_count = 999999

    has_audio = await _probe_has_audio(input_path)
    return {
        "width": w, "height": h, "fps": fps,
        "frame_count": frame_count, "has_audio": has_audio,
    }


def _build_spliced_mv_json(
    source_mv_json: dict,
    start_frame_0: int,
    n_payload_frames: int,
    transition_style: str = "smear",
    mv_multiplier: float = 1.0,
) -> dict:
    """Build an MV JSON matching a payload of *n_payload_frames* frames.

    - Frame 0 is an I-frame (empty ``mv``).
    - Frames 1..N-1 receive the source MVs from source frames
      [start_frame_0+1, start_frame_0+N) (0-indexed), reindexed to payload
      frames 1..N-1.
    - Source I-frames (missing MV data) fall back to the last known MVs so
      motion continuity is preserved within the hijack window.
    - For ``"freeze"`` mode all forward MVs are zeroed.
    - ``mv_multiplier`` scales every component (1.0 = as-is, 0.0 = freeze,
      3.0 = triple speed, etc.).
    """
    src_stream = source_mv_json["streams"][0]
    src_frames = src_stream["frames"]
    result_frames = []

    first_src = src_frames[0] if src_frames else {}
    result_frames.append({
        "pkt_pos": first_src.get("pkt_pos", 0),
        "pts": first_src.get("pts"),
        "dts": first_src.get("dts", 0),
        "mv": {}
    })

    last_mv: dict | None = None
    freeze = transition_style == "freeze" or (mv_multiplier == 0.0)

    for i in range(1, n_payload_frames):
        src_idx = start_frame_0 + i
        if 0 <= src_idx < len(src_frames):
            src_frame = src_frames[src_idx]
            src_mv = src_frame.get("mv", {})
            if src_mv and src_mv.get("forward"):
                last_mv = src_mv
                fcode = src_mv.get("fcode", [2, 2])
                if freeze or mv_multiplier != 1.0:
                    fwd = src_mv["forward"]
                    if freeze:
                        new_fwd = [[[0, 0] for _ in row] for row in fwd]
                    else:
                        new_fwd = [
                            [[round(pair[0] * mv_multiplier), round(pair[1] * mv_multiplier)]
                             for pair in row]
                            for row in fwd
                        ]
                    mv_data = {
                        "forward": new_fwd,
                        "fcode": fcode,
                        "overflow": "truncate",
                    }
                else:
                    mv_data = src_mv
                result_frames.append({
                    "pkt_pos": src_frame.get("pkt_pos", 0),
                    "pts": src_frame.get("pts"),
                    "dts": src_frame.get("dts", 0),
                    "mv": mv_data,
                })
            else:
                if last_mv:
                    result_frames.append({
                        "pkt_pos": src_frame.get("pkt_pos", 0),
                        "pts": src_frame.get("pts"),
                        "dts": src_frame.get("dts", 0),
                        "mv": last_mv,
                    })
                else:
                    result_frames.append({
                        "pkt_pos": src_frame.get("pkt_pos", 0),
                        "pts": src_frame.get("pts"),
                        "dts": src_frame.get("dts", 0),
                        "mv": {},
                    })
        else:
            result_frames.append({
                "pkt_pos": 0, "pts": None, "dts": 0, "mv": {},
            })

    return {
        "ffedit_version": source_mv_json.get("ffedit_version", ""),
        "filename": source_mv_json.get("filename", ""),
        "sha1sum": source_mv_json.get("sha1sum", ""),
        "features": source_mv_json.get("features", ["mv"]),
        "streams": [{
            "codec": src_stream.get("codec", "mpeg2video"),
            "frames": result_frames,
        }],
    }


async def _encode_source_m2v(
    input_path: str,
    out_m2v: str,
    info: dict,
) -> tuple[bool, str]:
    """Encode the source to raw MPEG-2 with suppressed keyframes (fcode=2).

    Using ``-g 9999`` makes only the first frame an I-frame; every subsequent
    frame is a P-frame with forward motion vectors — ideal for MV extraction.
    """
    ffgac_cmd = [
        "ffgac", "-i", input_path, "-an",
        "-vcodec", "mpeg2video",
        "-mpv_flags", "+nopimb+forcemv",
        "-intra_penalty", "1000000000",
        "-fcode", "2",
        "-qscale:v", "1",
        "-g", "9999",
        "-sc_threshold", "100",
        "-f", "rawvideo",
        "-y", out_m2v,
    ]
    code, _, err = await run_command(ffgac_cmd)
    if code != 0:
        return False, f"ffgac source encode failed: {err.strip()}"
    return True, ""


async def _create_payload_yuv(
    inject_image_path: str,
    out_yuv: str,
    n_frames: int,
    w: int, h: int, fps: float,
) -> tuple[bool, str]:
    """Create a raw YUV420p file with *n_frames* repetitions of *inject_image_path*,
    scaled/padded to *w*×*h* and timed at *fps*.
    """
    fps_str = str(int(round(fps))) if fps == int(fps) else str(fps)
    cmd = [
        "ffmpeg", "-y", "-loop", "1", "-i", inject_image_path,
        "-vf", (
            f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1"
        ),
        "-vframes", str(n_frames),
        "-r", fps_str,
        "-pix_fmt", "yuv420p",
        "-f", "rawvideo",
        out_yuv,
    ]
    code, _, err = await run_command(cmd)
    if code != 0:
        return False, f"payload YUV creation failed: {err.strip()}"
    return True, ""


async def _encode_payload_m2v(
    in_yuv: str,
    out_m2v: str,
    w: int, h: int, fps: float,
    fcode: int,
) -> tuple[bool, str]:
    """Encode the payload raw YUV as MPEG-2 P-frames (I-frame only at frame 0)."""
    ffgac_cmd = [
        "ffgac", "-f", "rawvideo", "-video_size", f"{w}x{h}",
        "-r", str(int(round(fps))) if fps == int(fps) else str(fps),
        "-i", in_yuv,
        "-an",
        "-vcodec", "mpeg2video",
        "-mpv_flags", "+nopimb+forcemv",
        "-intra_penalty", "1000000000",
        "-fcode", str(fcode),
        "-qscale:v", "1",
        "-g", "9999",
        "-sc_threshold", "100",
        "-f", "rawvideo",
        "-y", out_m2v,
    ]
    code, _, err = await run_command(ffgac_cmd)
    if code != 0:
        return False, f"ffgac payload encode failed: {err.strip()}"
    return True, ""


def _max_fcode_in_range(source_mv_json: dict, start_0: int, end_0_exclusive: int) -> int:
    """Find the maximum fcode value across source MVs in the given frame range.
    Falls back to 2 if none found.
    """
    frames = source_mv_json["streams"][0]["frames"]
    max_fc = 0
    for idx in range(start_0, end_0_exclusive):
        if idx >= len(frames):
            break
        mv = frames[idx].get("mv", {})
        fcode = mv.get("fcode")
        if fcode and isinstance(fcode, list) and len(fcode) >= 2:
            max_fc = max(max_fc, max(fcode))
    return max(max_fc, 2)


def _scan_mv_magnitude(source_mv_json: dict, start_0: int, end_0_exclusive: int) -> tuple[int, int]:
    """Return (max_abs_x, max_abs_y) across all MVs in the given source range."""
    frames = source_mv_json["streams"][0]["frames"]
    max_x, max_y = 0, 0
    for idx in range(start_0, end_0_exclusive):
        if idx >= len(frames):
            break
        mv = frames[idx].get("mv", {})
        fwd = mv.get("forward")
        if fwd:
            for row in fwd:
                for pair in row:
                    max_x = max(max_x, abs(pair[0]))
                    max_y = max(max_y, abs(pair[1]))
    return max_x, max_y


def _fcode_for_max_mv(max_abs: int) -> int:
    """Determine the minimum MPEG-2 fcode that can represent *max_abs*."""
    if max_abs <= 16:
        return 1
    if max_abs <= 32:
        return 2
    if max_abs <= 64:
        return 3
    if max_abs <= 128:
        return 4
    return 5


async def _execute_hijack_pipeline(
    operation: str,
    input_path: str,
    output_path: str,
    inject_mode: str | None = None,
    inject_image_path: str | None = None,
    inject_frame_num: int = 0,
    start_frame: int = 1,
    end_frame: int = 999999,
    transition_style: str = "smear",
    mv_multiplier: float = 1.0,
    dry_run: bool = False,
) -> OperationResult:
    """Visual Hijack via motion-vector payload injection.

    Replaces the splice-and-destroy residual approach with a clean
    source-MV → payload transfer:
    1. Encode source to MPEG-2 (suppressed keyframes, fcode=2)
    2. Export source motion vectors
    3. Create a payload video (image repeated N frames) as MPEG-2 P-frames
    4. Apply source MVs to the payload via ``ffedit -a``
    5. Splice the hijacked segment between clean source bookends
    """
    from ...pathutil import unique_output_path
    from ... import job_control

    mode_desc = (
        f"datamosh hijack inject={inject_mode} start={start_frame} end={end_frame} "
        f"style={transition_style} mult={mv_multiplier} -> {output_path}"
    )
    if dry_run:
        return OperationResult(
            ok=True, operation=operation, output_path=output_path,
            dry_run=True, command=mode_desc, stdout=f"Command: {mode_desc}\n",
        )

    if not os.path.exists(input_path):
        return OperationResult(
            ok=False, operation=operation,
            error=f"Input file not found: {input_path}",
        )

    output_path = str(unique_output_path(output_path))
    info = await _probe_source_info(input_path)
    w, h, fps = info["width"], info["height"], info["fps"]
    total_frames = info["frame_count"]
    has_audio = info["has_audio"]

    start_frame = max(start_frame, 1)
    if end_frame >= 999999 or end_frame > total_frames:
        end_frame = total_frames
    if end_frame < start_frame:
        return OperationResult(
            ok=False, operation=operation,
            error=f"end_frame ({end_frame}) < start_frame ({start_frame})",
        )

    n_hijack = end_frame - start_frame + 1
    if n_hijack < 2:
        return OperationResult(
            ok=False, operation=operation,
            error=f"Hijack interval too short: {n_hijack} frames (need >= 2: 1 I-frame + 1 P-frame)",
        )

    start_frame_0 = start_frame - 1  # convert 1-indexed → 0-indexed

    with tempfile.TemporaryDirectory() as tmpdir:
        # ── Step 1: Resolve inject image ──────────────────────────────────
        job_control.check_cancelled()
        inject_img = inject_image_path
        if inject_mode == "frame":
            inject_img = os.path.join(tmpdir, "extracted.png")
            code, _, err = await run_command([
                "ffmpeg", "-y", "-i", input_path,
                "-vf", f"select=eq(n\\,{inject_frame_num})",
                "-vframes", "1",
                inject_img,
            ])
            if code != 0:
                return OperationResult(
                    ok=False, operation=operation,
                    error=f"Frame extraction failed: {err.strip()}",
                )
        if not inject_img or not os.path.exists(inject_img):
            return OperationResult(
                ok=False, operation=operation,
                error=f"Injected image not found: {inject_img}",
            )

        # ── Step 2: Encode source to m2v for MV extraction ──────────────
        job_control.check_cancelled()
        src_m2v = os.path.join(tmpdir, "source.m2v")
        ok, err = await _encode_source_m2v(input_path, src_m2v, info)
        if not ok:
            return OperationResult(ok=False, operation=operation, error=err)

        # ── Step 3: Export source MVs ───────────────────────────────────
        job_control.check_cancelled()
        src_mv_json_path = os.path.join(tmpdir, "source_mv.json")
        export_cmd = ["ffedit", "-i", src_m2v, "-f", "mv:0", "-e", src_mv_json_path]
        code, _, err = await run_command(export_cmd)
        if code != 0:
            return OperationResult(
                ok=False, operation=operation,
                error=f"MV export failed: {err.strip()}",
            )

        # ── Step 4: Determine fcode and build spliced MV JSON ─────────────
        job_control.check_cancelled()
        with open(src_mv_json_path) as f:
            source_mv_json = json.load(f)

        src_end_0 = start_frame_0 + n_hijack  # exclusive
        max_abs_x, max_abs_y = _scan_mv_magnitude(source_mv_json, start_frame_0, src_end_0)
        max_abs = max(max_abs_x, max_abs_y)
        # Use the max of the source's fcode and what the MVs require
        src_fcode = _max_fcode_in_range(source_mv_json, start_frame_0, src_end_0)
        req_fcode = _fcode_for_max_mv(max_abs)
        payload_fcode = max(src_fcode, req_fcode)

        spliced_mv = _build_spliced_mv_json(
            source_mv_json, start_frame_0, n_hijack,
            transition_style=transition_style,
            mv_multiplier=mv_multiplier,
        )
        spliced_mv_path = os.path.join(tmpdir, "spliced_mv.json")
        with open(spliced_mv_path, "w") as f:
            json.dump(spliced_mv, f)

        # ── Step 5: Create payload raw YUV ────────────────────────────────
        job_control.check_cancelled()
        payload_yuv = os.path.join(tmpdir, "payload.yuv")
        ok, err = await _create_payload_yuv(
            inject_img, payload_yuv, n_hijack, w, h, fps,
        )
        if not ok:
            return OperationResult(ok=False, operation=operation, error=err)

        # ── Step 6: Encode payload to m2v ─────────────────────────────────
        job_control.check_cancelled()
        payload_m2v = os.path.join(tmpdir, "payload.m2v")
        ok, err = await _encode_payload_m2v(
            payload_yuv, payload_m2v, w, h, fps, payload_fcode,
        )
        if not ok:
            return OperationResult(ok=False, operation=operation, error=err)

        # ── Step 7: Apply source MVs to payload ─────────────────────────
        job_control.check_cancelled()
        hijacked_m2v = os.path.join(tmpdir, "hijacked.m2v")
        if transition_style == "freeze":
            # For freeze, don't apply MVs — the payload's own zero MVs suffice
            shutil.copy2(payload_m2v, hijacked_m2v)
        else:
            ffedit_cmd = [
                "ffedit", "-i", payload_m2v, "-f", "mv",
                "-a", spliced_mv_path, "-o", hijacked_m2v, "-y",
            ]
            code, _, err = await run_command(ffedit_cmd)
            if code != 0:
                return OperationResult(
                    ok=False, operation=operation,
                    error=f"ffedit MV application failed: {err.strip()}",
                )

        # ── Step 8: Convert hijacked m2v → mp4 ────────────────────────────
        job_control.check_cancelled()
        hijacked_mp4 = os.path.join(tmpdir, "hijacked.mp4")
        fps_str = str(int(round(fps))) if fps == int(fps) else str(fps)
        ffmpeg_cmd = [
            "ffmpeg", "-y",
            "-r", fps_str, "-i", hijacked_m2v,
            "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
            "-an",
            hijacked_mp4,
        ]
        code, out_hijack, err_hijack = await run_command(ffmpeg_cmd)
        if code != 0:
            return OperationResult(
                ok=False, operation=operation,
                error=f"Hijacked segment re-encode failed: {err_hijack.strip()}",
            )

        # ── Step 9: Assemble final output with clean bookends ───────────
        job_control.check_cancelled()
        segments: list[str] = []
        seg_labels: list[str] = []

        # Part A: clean source before hijack (video-only, audio extracted separately)
        if start_frame_0 > 0:
            part_a = os.path.join(tmpdir, "partA.mp4")
            cut_cmd = [
                "ffmpeg", "-y", "-i", input_path,
                "-t", f"{start_frame_0 * (1.0 / fps):.6f}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-an",  # audio handled separately (source-wide)
                part_a,
            ]
            code, _, err = await run_command(cut_cmd)
            if code == 0 and os.path.exists(part_a):
                segments.append(part_a)
                seg_labels.append("A")

        # Hijacked segment (video-only)
        segments.append(hijacked_mp4)
        seg_labels.append("H")

        # Part C: clean source after hijack (video-only)
        post_start_0 = end_frame  # 0-indexed first frame after hijack
        if post_start_0 < total_frames:
            part_c = os.path.join(tmpdir, "partC.mp4")
            ss_time = post_start_0 * (1.0 / fps)
            cut_cmd = [
                "ffmpeg", "-y", "-ss", f"{ss_time:.6f}", "-i", input_path,
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-an",
                part_c,
            ]
            code, _, err = await run_command(cut_cmd)
            if code == 0 and os.path.exists(part_c):
                segments.append(part_c)
                seg_labels.append("C")

        # Remove any segment without video
        good_segs: list[str] = []
        for seg in segments:
            if os.path.exists(seg) and os.path.getsize(seg) > 100:
                good_segs.append(seg)
        if not good_segs:
            return OperationResult(
                ok=False, operation=operation,
                error="No valid segments to concatenate",
            )

        job_control.check_cancelled()

        # Concatenate video-only (audio is muxed from the full source after concat)
        n = len(good_segs)
        vlabels = "".join(f"[{i}:v]" for i in range(n))
        filter_str = f"{vlabels}concat=n={n}:v=1:a=0[outv]"
        concat_cmd = [
            "ffmpeg", "-y", *[x for seg in good_segs for x in ["-i", seg]],
            "-filter_complex", filter_str,
            "-map", "[outv]",
            "-an",
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            output_path,
        ]

        code, out_concat, err_concat = await run_command(concat_cmd)
        if code != 0:
            return OperationResult(
                ok=False, operation=operation,
                error=f"Video concat failed: {err_concat.strip()}",
            )

        # ── Step 10: Preserve audio from the original source ────────────
        if has_audio:
            job_control.check_cancelled()
            audio_tmp = os.path.join(tmpdir, "source_audio.aac")
            ext_code, _, ext_err = await run_command([
                "ffmpeg", "-y", "-i", input_path,
                "-c:a", "aac", "-b:a", "192k",
                audio_tmp,
            ])
            if ext_code == 0 and os.path.exists(audio_tmp) and os.path.getsize(audio_tmp) > 100:
                # Extract video from the concat output and mux with the source audio
                recoded = os.path.join(tmpdir, "final_with_audio.mp4")
                mux_code, _, mux_err = await run_command([
                    "ffmpeg", "-y",
                    "-i", output_path,
                    "-i", audio_tmp,
                    "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k",
                    "-shortest",
                    recoded,
                ])
                if mux_code == 0 and os.path.exists(recoded):
                    shutil.move(recoded, output_path)
                else:
                    # Keep video-only if muxing fails; audio is non-fatal
                    pass

        return OperationResult(
            ok=True,
            operation=operation,
            output_path=output_path,
            command=(
                f"ffgac (source m2v) -> ffedit -e (MV export) -> "
                f"ffgac (payload) -> ffedit -a (MV apply) -> "
                f"ffmpeg concat({'|'.join(seg_labels[:len(good_segs)])})"
            ),
            stdout=f"ffgac: ok\nffedit: ok\nffmpeg concat:\n{out_concat}",
            stderr=err_concat,
        )
