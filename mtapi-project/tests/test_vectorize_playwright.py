"""Vectorize tab UI proof — clicks the real controls in a browser (AGENTS.md §12).

Tests:
1. Standard form controls render (Engine, Presets) and NO local input/output (uses global in/out).
2. Global Run button (#btnRun) is visible and runs the vectorize operation using global inputs.
3. Media preview displays the resulting SVG.
4. Standard validation refuses with dialog when no global input is provided.
"""
import os
import sys
from pathlib import Path
import pytest
from playwright.sync_api import sync_playwright

BASE = os.environ.get("FF_BASE_URL", "http://127.0.0.1:24590")
pytestmark = pytest.mark.skipif(
    os.environ.get("FF_UI_PROOF") != "1",
    reason="set FF_UI_PROOF=1 to run the browser proof",
)


def set_global_in_out(page, media_in, media_out=None):
    page.evaluate(
        """([mediaIn, mediaOut]) => {
            const inEl = document.getElementById('giMediaIn');
            if (inEl) {
                inEl.value = mediaIn;
                inEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (mediaOut !== null && mediaOut !== undefined) {
                const outEl = document.getElementById('giMediaOut');
                if (outEl) {
                    outEl.value = mediaOut;
                    outEl.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        }""",
        [media_in, media_out],
    )


def test_vectorize_tab_renders_controls():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.goto(BASE, wait_until="networkidle")

        # Click the real nav item.
        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('#vectorizeEngine', timeout=10000)

        # Local input/output controls must NOT exist (uses global bar)
        assert page.query_selector('#vectorizeInput') is None, "local vectorizeInput should not exist"
        assert page.query_selector('#btnVectorizeBrowseIn') is None, "btnVectorizeBrowseIn should not exist"
        assert page.query_selector('#vectorizeOutput') is None, "local vectorizeOutput should not exist"
        assert page.query_selector('#btnVectorizeBrowseOut') is None, "btnVectorizeBrowseOut should not exist"

        # Engine selector options
        assert page.is_visible('#vectorizeEngine'), "vectorizeEngine not visible"
        engines = page.eval_on_selector(
            '#vectorizeEngine',
            "el => Array.from(el.options).map(o => o.value)",
        )
        assert "vtracer" in engines, "vtracer engine missing"
        assert "inkscape" in engines, "inkscape engine missing"
        assert "all" in engines, "all option missing"

        # Select vtracer and verify its options block is visible
        page.select_option('#vectorizeEngine', 'vtracer')
        assert page.is_visible('#vtracerOptionsBlock'), "vtracerOptionsBlock not visible"
        assert page.is_visible('#vectorizePreset'), "vectorizePreset not visible"
        assert page.is_visible('#vectorizeColors'), "vectorizeColors not visible"

        # Switching engine to inkscape toggles options visibility
        page.select_option('#vectorizeEngine', 'inkscape')
        assert page.is_visible('#inkscapeOptionsBlock'), "inkscapeOptionsBlock should be visible"
        assert not page.is_visible('#vtracerOptionsBlock'), "vtracerOptionsBlock should be hidden"

        page.select_option('#vectorizeEngine', 'vtracer')
        assert page.is_visible('#vtracerOptionsBlock'), "vtracerOptionsBlock should be visible again"

        # Global-only: no private upload input and no private run button
        assert page.query_selector('#v-file') is None, "private upload input should not exist"
        assert page.query_selector('#v-run-btn') is None, "private run button should not exist"
        btn_run = page.query_selector('#btnRun')
        assert btn_run is not None, "global Run button missing"
        assert btn_run.is_visible(), "global Run button hidden on vectorize tab"

        # GitHub repo header integration
        gh_btn = page.query_selector('#headerGithubWrap')
        assert gh_btn is not None, "GitHub header dropdown wrap missing"

        # No uncaught fatal errors from the tab module
        fatal = [e for e in errors if 'error' in e.lower() and 'vectorize' in e.lower()]
        assert not fatal, f"console errors from tab: {fatal}"

        browser.close()


def test_vectorize_runs_via_global_btn_run():
    """Runs vectorization using global input/output and global Run button."""
    out_dir = "/tmp/vout_global_test"
    os.makedirs(out_dir, exist_ok=True)
    assert os.path.exists("/tmp/vtest.png"), "fixture /tmp/vtest.png missing"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.goto(BASE, wait_until="networkidle")

        # Set the REAL global input/output bars
        set_global_in_out(page, '/tmp/vtest.png', out_dir)

        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('#vectorizeEngine', timeout=10000)

        page.select_option('#vectorizeEngine', 'vtracer')
        page.select_option('#vectorizePreset', 'photo')

        # Click the GLOBAL Run button
        page.click('#btnRun')

        # Wait for SVG to render in mediaViewer (proving run success & preview display)
        page.wait_for_selector('#mediaViewer img', timeout=30000)
        img_src = page.get_attribute('#mediaViewer img', 'src')
        assert '.svg' in img_src, f"media viewer not displaying output SVG: {img_src}"

        # Status indicator should show completion
        status = page.inner_text('#statusText')
        assert 'Success' in status or 'complete' in status or 'Ready' in status, f"unexpected status text: {status}"

        # Proof screenshot
        page.screenshot(path="mtapi-project/junk/vectorize_tab_proof.png")

        fatal = [e for e in errors if 'error' in e.lower() and 'vectorize' in e.lower()]
        assert not fatal, f"console errors from tab: {fatal}"
        browser.close()


def test_vectorize_inkscape_runs_via_global_btn_run():
    """Runs Inkscape vectorization using global input/output and global Run button."""
    out_dir = "/tmp/vout_inkscape_test"
    os.makedirs(out_dir, exist_ok=True)
    assert os.path.exists("/tmp/vtest.png"), "fixture /tmp/vtest.png missing"

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(BASE, wait_until="networkidle")

        set_global_in_out(page, '/tmp/vtest.png', out_dir)

        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('#vectorizeEngine', timeout=10000)

        page.select_option('#vectorizeEngine', 'inkscape')

        page.click('#btnRun')

        page.wait_for_selector('#mediaViewer img', timeout=30000)
        img_src = page.get_attribute('#mediaViewer img', 'src')
        assert '.svg' in img_src, f"media viewer not displaying output SVG: {img_src}"

        browser.close()


def test_vectorize_refuses_without_input():
    """Standard Run must refuse when no input is provided."""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(BASE, wait_until="networkidle")

        # Ensure global input is empty
        set_global_in_out(page, '')

        page.click('.nav-item[data-tab="vectorize"]')
        page.wait_for_selector('#vectorizeEngine', timeout=10000)

        dialogs = []
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))
        page.click('#btnRun')

        for _ in range(50):
            if dialogs:
                break
            page.wait_for_timeout(100)

        assert dialogs, "no refusal dialog shown by the global Run button"
        assert any('Input image' in m for m in dialogs), \
            f"refusal message unexpected: {dialogs}"
        browser.close()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
