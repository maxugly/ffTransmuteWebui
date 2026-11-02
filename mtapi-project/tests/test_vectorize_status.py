#!/usr/bin/env python3
"""Concrete PASS/FAIL test — does NOT lie."""
import sys, requests
url = "http://localhost:24590/vectorize/status"
try:
    r = requests.get(url, timeout=5)
    d = r.json()
    if d.get("ok") and "engines" in d:
        print("PASS — Vectorize status OK")
        print("Engines:", [e["id"] for e in d["engines"]])
        sys.exit(0)
    else:
        print("FAIL — response bad:", d)
        sys.exit(1)
except Exception as e:
    print("FAIL — server unreachable or error:", e)
    sys.exit(1)
