#!/usr/bin/env python3
"""Convenience entry point: `python run.py`. For reload-on-save during
development, use `uvicorn app.main:app --reload` directly instead."""
import uvicorn

if __name__ == "__main__":
    uvicorn.run("app.main:app", host="0.0.0.0", port=24590)
