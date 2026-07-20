"""
datamosh.sh logic implemented directly in Python to support advanced creative controls:
- Melt (continuous motion-vector averaged smear)
- Classic (no-keyframe mosh at cuts)
- Visual Hijack (inject an image/frame at a start frame range and recover at end frame)
- Residual Destruct (zero out DCT error correction coefficients to force pixel bleed)
- Motion Vector Hack (multiply or drift vectors in a custom frame range)
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from pydantic import BaseModel, Field

from ..contract import OperationResult, OperationSpec, register
from ..shell import run_command, BIN_DIR

CUSTOM_GLITCH_JS = str(BIN_DIR / "custom_glitch.js")
NO_KEYFRAME_JS = str(BIN_DIR / "no_keyframe.js")
MELT_JS = str(BIN_DIR / "melt.js")


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
    end_frame: int = 999999
) -> OperationResult:
    # Validate input file
    if not os.path.exists(input_path):
        return OperationResult(
            ok=False,
            operation=operation,
            error=f"Input file not found: {input_path}"
        )

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

                # Replace the first frame of Part 2 with the image
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

                # Concatenate image + Part 2
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
            "-g", "max", "-sc_threshold", "max"
        ]
        # Suppress keyframes for classic, destruct, mv_hack, and freeze modes
        if glitch_mode != 0:
            ffgac_cmd.extend(["-pict_type_script", NO_KEYFRAME_JS])
            
        ffgac_cmd.extend(["-f", "rawvideo", "-y", tmp_prepped])

        code_ffgac, out_ffgac, err_ffgac = await run_command(ffgac_cmd, cwd=cwd)
        if code_ffgac != 0:
            return OperationResult(
                ok=False,
                operation=operation,
                error=f"ffgac transcode failed: {err_ffgac.strip()}"
            )

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


# --- 1. Melt Mode ---
class DatamoshMeltParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str = Field(..., description="Where to write the result")
    tail: int = Field(18, ge=1, description="Frames of 'memory' in the smear")
    hdamp: int = Field(15, ge=0, le=100, description="Horizontal damping percent (0-100)")
    vdrift: int = Field(1, description="Constant per-frame vertical push")


async def datamosh_melt(p: DatamoshMeltParams) -> OperationResult:
    return await _execute_mosh_pipeline(
        "datamosh_melt",
        p.input_path,
        p.output_path,
        glitch_mode=0,
        glitch_params=[p.tail, p.hdamp, p.vdrift]
    )


register(OperationSpec(
    id="datamosh_melt",
    summary="Continuous motion-vector melt/drip effect",
    description="Accumulates motion vectors over previous frames to smear pixels continuously.",
    params_model=DatamoshMeltParams,
    handler=datamosh_melt,
    tags=["datamosh"],
))


# --- 2. Classic Mode ---
class DatamoshClassicParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str = Field(..., description="Where to write the result")


async def datamosh_classic(p: DatamoshClassicParams) -> OperationResult:
    return await _execute_mosh_pipeline(
        "datamosh_classic",
        p.input_path,
        p.output_path,
        glitch_mode=1,
        glitch_params=[]
    )


register(OperationSpec(
    id="datamosh_classic",
    summary="Keyframe-suppression mosh at existing cuts",
    description="Suppresses all keyframes. Glitches appear naturally at hard camera cuts.",
    params_model=DatamoshClassicParams,
    handler=datamosh_classic,
    tags=["datamosh"],
))


# --- 3. Visual Hijack Mode (P-Frame Injection) ---
class DatamoshHijackParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str = Field(..., description="Where to write the result")
    inject_mode: str = Field("file", description="Source of injected image: 'file' or 'frame'")
    inject_image_path: str | None = Field(None, description="Absolute path to the image file (if mode is 'file')")
    inject_frame_num: int = Field(0, ge=0, description="Source frame number to extract (if mode is 'frame')")
    start_frame: int = Field(1, ge=1, description="Injection frame position where the glitch starts")
    end_frame: int = Field(999999, ge=1, description="Recovery frame position where the video recovers")
    transition_style: str = Field("smear", description="Glitch transition behavior: 'smear' (clear residuals, keep vectors) or 'freeze' (clear residuals, zero vectors)")


async def datamosh_hijack(p: DatamoshHijackParams) -> OperationResult:
    mode_val = 2 if p.transition_style == "smear" else 4
    relative_end = p.end_frame - p.start_frame
    if relative_end < 0:
        relative_end = 999999
        
    return await _execute_mosh_pipeline(
        "datamosh_hijack",
        p.input_path,
        p.output_path,
        glitch_mode=mode_val,
        glitch_params=[0, relative_end, 100, 0, 0], # start relative frame 0, end relative end_frame
        inject_mode=p.inject_mode,
        inject_image_path=p.inject_image_path,
        inject_frame_num=p.inject_frame_num,
        start_frame=p.start_frame,
        end_frame=p.end_frame
    )


register(OperationSpec(
    id="datamosh_hijack",
    summary="Visual Hijack (P-Frame Image Injection)",
    description="Injects an image at a specific frame, dragging it with video motion or freezing it, and recovers at an end frame.",
    params_model=DatamoshHijackParams,
    handler=datamosh_hijack,
    tags=["datamosh"],
))


# --- 4. Residual Destruct Mode ---
class DatamoshDestructParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str = Field(..., description="Where to write the result")
    start_frame: int = Field(1, ge=0, description="Start frame of residual destruction")
    end_frame: int = Field(999999, ge=0, description="End frame of residual destruction")


async def datamosh_destruct(p: DatamoshDestructParams) -> OperationResult:
    return await _execute_mosh_pipeline(
        "datamosh_destruct",
        p.input_path,
        p.output_path,
        glitch_mode=2,
        glitch_params=[p.start_frame, p.end_frame, 0, 0, 0]
    )


register(OperationSpec(
    id="datamosh_destruct",
    summary="Residual Destruct (DCT Coefficient clearing)",
    description="Zeroes out macroblock corrections to trigger visual bleeding without scene cuts.",
    params_model=DatamoshDestructParams,
    handler=datamosh_destruct,
    tags=["datamosh"],
))


# --- 5. Motion Vector Hack Mode ---
class DatamoshMvHackParams(BaseModel):
    input_path: str = Field(..., description="Source video path")
    output_path: str = Field(..., description="Where to write the result")
    start_frame: int = Field(1, ge=0, description="Start frame of vector override")
    end_frame: int = Field(999999, ge=0, description="End frame of vector override")
    multiplier: float = Field(1.0, description="Motion speed multiplier (e.g. 0.0 to freeze, 2.0 to double)")
    drift_h: int = Field(0, description="Constant horizontal pixel drift nudge")
    drift_v: int = Field(0, description="Constant vertical pixel drift nudge")


async def datamosh_mv_hack(p: DatamoshMvHackParams) -> OperationResult:
    mult_percent = int(round(p.multiplier * 100))
    return await _execute_mosh_pipeline(
        "datamosh_mv_hack",
        p.input_path,
        p.output_path,
        glitch_mode=3,
        glitch_params=[p.start_frame, p.end_frame, mult_percent, p.drift_h, p.drift_v]
    )


register(OperationSpec(
    id="datamosh_mv_hack",
    summary="Motion Vector Hack (Custom motion warping)",
    description="Directly scales or drift-nudges motion vectors within a target frame range.",
    params_model=DatamoshMvHackParams,
    handler=datamosh_mv_hack,
    tags=["datamosh"],
))
