"""Vectorize tab proof — minimal Playwright-level test skeleton."""
import requests, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__),'..','mtapi-project','app'))

def test_vectorize_status():
    r = requests.get("http://localhost:24590/vectorize/status")
    d = r.json()
    assert d.get("ok") is True
    assert "engines" in d

def test_vectorize_manifest():
    r = requests.get("http://localhost:24590/vectorize/manifest")
    d = r.json()
    assert d.get("ok") is True
    assert "manifests" in d
    assert "vtracer" in d["manifests"]

if __name__ == "__main__":
    test_vectorize_status()
    test_vectorize_manifest()
    print("vectorize tests ok")
