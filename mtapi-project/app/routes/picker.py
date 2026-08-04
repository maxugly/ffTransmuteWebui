"""Native file picker route — kdialog on KDE, zenity on GNOME, tkinter fallback."""
import asyncio
import shutil
from pathlib import Path

from fastapi import FastAPI, HTTPException

WORKSPACE_PATH = "/home/m/snc/cod/ffTransmuteWebui"


def register(app: FastAPI) -> None:
    @app.get("/api/picker", tags=["meta"])
    async def open_native_picker(
        mode: str = "file",
        start_path: str = "",
        filter: str = "video",
    ):
        """Native file dialog. modes: file | files | dir | save.
        `files` returns {paths: [...], path: first} for multi-select.
        filter: video (default) | image | project | all — file-type filter.
        """
        kdialog_path = shutil.which("kdialog")
        zenity_path = shutil.which("zenity")

        if not start_path:
            start_path = WORKSPACE_PATH

        filter_key = (filter or "video").lower()
        if filter_key == "project":
            kdialog_filter = (
                "ffTransmute Project (*.ffproject.json *.ffproj);;"
                "JSON (*.json);;All Files (*)"
            )
            filetypes = [
                ("ffTransmute Project", "*.ffproject.json *.ffproj"),
                ("JSON", "*.json"),
                ("All files", "*.*"),
            ]
            zenity_pattern = "*.ffproject.json *.ffproj *.json"
            zenity_filters = [
                "ffTransmute Project | *.ffproject.json *.ffproj",
                "All files | *",
            ]
        elif filter_key == "image":
            # All common stills — open dialogs must lead with this (not PNG-only).
            _img_all = (
                "*.png *.jpg *.jpeg *.webp *.bmp *.gif "
                "*.tif *.tiff *.ppm *.pgm *.svg"
            )
            if mode == "save":
                # Save: PNG first is a reasonable default extension for new files.
                kdialog_filter = (
                    f"PNG image (*.png);;"
                    f"Images ({_img_all});;"
                    f"JPEG (*.jpg *.jpeg);;"
                    f"WebP (*.webp);;"
                    f"All Files (*)"
                )
                filetypes = [
                    ("PNG image", "*.png"),
                    ("Images", _img_all),
                    ("JPEG", "*.jpg *.jpeg"),
                    ("WebP", "*.webp"),
                    ("All files", "*.*"),
                ]
                zenity_filters = [
                    "PNG image | *.png",
                    f"Images | {_img_all}",
                    "JPEG | *.jpg *.jpeg",
                    "WebP | *.webp",
                    "All files | *",
                ]
            else:
                # Open (file / files): default filter = all image types.
                kdialog_filter = (
                    f"Images ({_img_all});;"
                    f"JPEG (*.jpg *.jpeg);;"
                    f"PNG (*.png);;"
                    f"WebP (*.webp);;"
                    f"GIF (*.gif);;"
                    f"TIFF (*.tif *.tiff);;"
                    f"BMP (*.bmp);;"
                    f"All Files (*)"
                )
                filetypes = [
                    ("Images", _img_all),
                    ("JPEG", "*.jpg *.jpeg"),
                    ("PNG", "*.png"),
                    ("WebP", "*.webp"),
                    ("GIF", "*.gif"),
                    ("TIFF", "*.tif *.tiff"),
                    ("BMP", "*.bmp"),
                    ("All files", "*.*"),
                ]
                zenity_filters = [
                    f"Images | {_img_all}",
                    "JPEG | *.jpg *.jpeg",
                    "PNG | *.png",
                    "WebP | *.webp",
                    "GIF | *.gif",
                    "TIFF | *.tif *.tiff",
                    "BMP | *.bmp",
                    "All files | *",
                ]
            zenity_pattern = _img_all
        elif filter_key == "all":
            kdialog_filter = "All Files (*)"
            filetypes = [("All files", "*.*")]
            zenity_pattern = "*"
            zenity_filters = []
        else:
            kdialog_filter = (
                "Video Files (*.mp4 *.mkv *.avi *.mov *.m4v *.webm *.mpg *.mpeg);;All Files (*)"
            )
            filetypes = [
                ("Video files", "*.mp4 *.mkv *.avi *.mov *.m4v *.webm *.mpg *.mpeg"),
                ("All files", "*.*"),
            ]
            zenity_pattern = "*.mp4 *.mkv *.avi *.mov *.m4v *.webm *.mpg *.mpeg"
            zenity_filters = [
                "Video files | *.mp4 *.mkv *.avi *.mov *.m4v *.webm *.mpg *.mpeg",
                "All files | *",
            ]

        def _result_from_paths(paths: list[str]) -> dict:
            paths = [p for p in paths if p]
            return {
                "path": paths[0] if paths else None,
                "paths": paths,
            }

        cmd = []
        multi = mode == "files"

        if kdialog_path:
            if mode == "dir":
                cmd = [kdialog_path, "--getexistingdirectory", start_path]
            elif mode == "save":
                cmd = [kdialog_path, "--getsavefilename", start_path, kdialog_filter]
            elif multi:
                cmd = [
                    kdialog_path, "--multiple", "--separate-output",
                    "--getopenfilename", start_path, kdialog_filter,
                ]
            else:
                cmd = [kdialog_path, "--getopenfilename", start_path, kdialog_filter]
        elif zenity_path:
            if mode == "dir":
                cmd = [zenity_path, "--file-selection", "--directory", f"--filename={start_path}/"]
            elif mode == "save":
                cmd = [
                    zenity_path, "--file-selection", "--save", "--confirm-overwrite",
                    f"--filename={start_path}",
                ]
                for zf in zenity_filters:
                    cmd.append(f"--file-filter={zf}")
            elif multi:
                cmd = [
                    zenity_path, "--file-selection", "--multiple", "--separator=\n",
                    f"--filename={start_path}/",
                ]
                for zf in zenity_filters:
                    cmd.append(f"--file-filter={zf}")
            else:
                cmd = [zenity_path, "--file-selection", f"--filename={start_path}/"]
                for zf in zenity_filters:
                    cmd.append(f"--file-filter={zf}")
        else:
            try:
                import tkinter as tk
                from tkinter import filedialog
                root = tk.Tk()
                root.withdraw()
                root.wm_attributes("-topmost", 1)

                if mode == "dir":
                    path = filedialog.askdirectory(initialdir=start_path)
                    root.destroy()
                    return _result_from_paths([path] if path else [])
                if mode == "save":
                    def_ext = ""
                    if filter_key == "project":
                        def_ext = ".ffproject.json"
                    elif filter_key == "image":
                        def_ext = ".png"
                    path = filedialog.asksaveasfilename(
                        initialdir=str(Path(start_path).parent) if start_path else None,
                        initialfile=Path(start_path).name if start_path else None,
                        defaultextension=def_ext,
                        filetypes=filetypes,
                    )
                    root.destroy()
                    return _result_from_paths([path] if path else [])
                if multi:
                    paths = list(filedialog.askopenfilenames(
                        initialdir=start_path, filetypes=filetypes,
                    ))
                    root.destroy()
                    return _result_from_paths(paths)
                path = filedialog.askopenfilename(
                    initialdir=start_path, filetypes=filetypes,
                )
                root.destroy()
                return _result_from_paths([path] if path else [])
            except Exception:
                raise HTTPException(
                    status_code=501,
                    detail="No native file dialog utility found on server",
                )

        if cmd:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout_b, _ = await proc.communicate()
                if proc.returncode != 0:
                    return {"path": None, "paths": []}
                raw = stdout_b.decode().strip()
                if not raw:
                    return {"path": None, "paths": []}
                if multi:
                    paths = [p.strip() for p in raw.splitlines() if p.strip()]
                    return _result_from_paths(paths)
                return _result_from_paths([raw])
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        return {"path": None, "paths": []}
