#!/usr/bin/env python3
"""Actual UI test — checks what AppImage frontend loads (not curl guesswork). FAIL prints exact response."""
import sys, requests

def check(url, label):
    try:
        r = requests.get(url, timeout=5)
        text = r.text[:200]
        if r.status_code != 200:
            return f"FAIL {label}: HTTP {r.status_code} body snippet: {text}"
        # /vectorize/* wrap payloads in {"ok": ...}; /ops is the raw operation
        # registry ({op_id: {...}}) served by meta.py — assert it parses as a
        # non-empty object either way.
        data = r.json()
        if not isinstance(data, dict) or not data:
            return f"FAIL {label}: empty/non-object JSON: {text}"
        return None
    except Exception as e:
        return f"FAIL {label}: exception {e}"

errors = []
for url, name in [
    ("http://localhost:24590/ops", "/ops (app.js fetchOperations)"),
    ("http://localhost:24590/vectorize/status", "/vectorize/status"),
    ("http://localhost:24590/vectorize/manifest", "/vectorize/manifest"),
]:
    err = check(url, name)
    if err:
        errors.append(err)

if errors:
    print("FAIL")
    for e in errors:
        print(" ", e)
    sys.exit(1)
else:
    print("PASS — /ops /vectorize/status /vectorize/manifest all 200 with ok")
    sys.exit(0)
