"""Vectorize tab UI proof — clicks the real tab in a browser (AGENTS.md §12).

Asserts the panel is NOT empty and the engine list actually renders from
/vectorize/status. This is the "click the real control" proof; a curl 200 is
not UI proof.
"""
import os
import sys

import pytest
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FF_BASE_URL", "http://127.0.0.1:24590")
pytestmark = pytest.mark.skipif(
    os.environ.get("FF_UI_PROOF") != "1",
    reason="set FF_UI_PROOF=1 to run the browser proof",
)


def test_vectorize_tab_renders_engines():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.goto(BASE, wait_until="networkidle")

        # Click the real nav item.
        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('.vectorize-tab', timeout=10000)

        # Panel must not be empty.
        panel = page.inner_text('#actionPanelForm')
        assert panel.strip(), "Vectorize panel rendered empty"

        # The engine list must actually populate from /vectorize/status.
        page.wait_for_selector('#v-engines .v-engine-row', timeout=10000)
        rows = page.query_selector_all('#v-engines .v-engine-row')
        assert len(rows) >= 1, "no engine rows rendered"

        # vtracer is the working engine — it must be present and enabled.
        vtracer = page.query_selector('#v-en-vtracer')
        assert vtracer is not None, "vtracer checkbox missing"
        assert vtracer.is_enabled(), "vtracer should be enabled (module installed)"

        # Global-only: the private upload control must NOT exist.
        assert page.query_selector('#v-file') is None, "private upload input should not exist"
        assert page.query_selector('#v-run-btn') is not None, "run button missing"

        # No uncaught console errors from the tab module.
        fatal = [e for e in errors if 'vectorize' in e.lower()]
        assert not fatal, f"console errors from tab: {fatal}"

        browser.close()


def test_vectorize_uses_global_in_out():
    """Global bar must be visible on the tab and drive input/output (AGENTS §5)."""
    out_dir = "/tmp/vout_ui_test"
    os.makedirs(out_dir, exist_ok=True)
    assert os.path.exists("/tmp/vtest.png"), "fixture /tmp/vtest.png missing"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.goto(BASE, wait_until="networkidle")

        # Type into the REAL global input/output bars (fires updateGlobalInputs).
        page.fill('#giMediaIn', '/tmp/vtest.png')
        page.fill('#giMediaOut', out_dir)
        page.dispatch_event('#giMediaIn', 'input')
        page.dispatch_event('#giMediaOut', 'input')

        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('.vectorize-tab', timeout=10000)

        # The global bar must NOT be hidden on this tab.
        assert 'no-global-inputs' not in (page.get_attribute('body', 'class') or ''), \
            "global input bar hidden on vectorize tab"
        assert page.is_visible('#globalInputsPanel'), "global inputs panel not visible"
        panel_cls = page.get_attribute('#globalInputsPanel', 'class') or ''
        assert 'collapsed' not in panel_cls or page.is_visible('#globalInputsPanel')

        # The tab must mirror the resolved global input.
        page.wait_for_function(
            "document.querySelector('#v-global-io')?.textContent.includes('/tmp/vtest.png')",
            timeout=5000,
        )

        # Run through the globals — no private upload.
        page.click('#v-run-btn')
        page.wait_for_function(
            "document.querySelector('#v-run-status').textContent.startsWith('Done')",
            timeout=30000,
        )
        status = page.inner_text('#v-run-status')
        assert out_dir in status, f"output dir not reported in status: {status}"

        # Result SVG rendered and written into the GLOBAL output dir.
        # pathutil.finalize_output_path names it {src_stem}_{engine}.svg.
        page.wait_for_selector('#v-results svg', timeout=15000)
        assert os.path.exists(os.path.join(out_dir, 'vtest_vtracer.svg')), \
            "SVG not written to global output dir"

        fatal = [e for e in errors if 'vectorize' in e.lower() and 'error' in e.lower()]
        assert not fatal, f"console errors from tab: {fatal}"
        browser.close()


def test_vectorize_no_private_upload_paths():
    """The private upload/job path must not exist — global input only."""
    # Backend: /vectorize/upload must be gone.
    import requests
    r = requests.post(BASE + "/vectorize/upload", files={"file": ("x.png", b"")})
    assert r.status_code == 404, f"/vectorize/upload still exists (HTTP {r.status_code})"

    # Frontend: no upload control, run requires a global input.
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(BASE, wait_until="networkidle")
        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('.vectorize-tab', timeout=10000)
        assert page.query_selector('#v-file') is None, "file input still present"
        assert page.query_selector('#v-upload-status') is None, "upload status still present"

        # No global input set → run must refuse with the global-input hint.
        page.fill('#giMediaIn', '')
        page.dispatch_event('#giMediaIn', 'input')
        page.click('#v-run-btn')
        page.wait_for_function(
            "document.querySelector('#v-run-status').textContent.includes('global input')",
            timeout=5000,
        )
        browser.close()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
