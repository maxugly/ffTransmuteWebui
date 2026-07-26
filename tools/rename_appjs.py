#!/usr/bin/env python3
import os
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mtapi-project", "app", "static")
appjs = os.path.join(static_dir, "app.js")
bak = os.path.join(static_dir, "app.js.bak")
if os.path.exists(appjs):
    os.rename(appjs, bak)
    print(f"Renamed {appjs} -> {bak}")
else:
    print(f"{appjs} not found")
