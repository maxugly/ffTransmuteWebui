"""Image Compare tab UI proof — real browser automation (AGENTS.md §12).

Tests:
1. Scale to match toggle renders in compare toolbar and defaults to checked.
2. When checked, #icStage has .ic-scale-match and image layers compute object-fit: fill.
3. Unchecking toggles off .ic-scale-match and restores object-fit: contain.
4. Switching across Separate, Overlay, and A/B modes respects the toggle state.
5. Swapping A ↔ B preserves scale-to-match framing with the new base.
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


@pytest.fixture(scope="module", autouse=True)
def setup_test_images():
    from PIL import Image
    Image.new("RGB", (640, 360), (200, 50, 50)).save("/tmp/test_cmp_a.png")
    Image.new("RGB", (200, 200), (50, 200, 50)).save("/tmp/test_cmp_b.png")


def test_imgcompare_scale_to_match_toggle():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("console", lambda m: errors.append(f"{m.type}: {m.text}"))
        page.goto(BASE, wait_until="networkidle")

        # Navigate to Image Compare tab
        page.click('.nav-item[data-tab="imgcompare"]')
        page.wait_for_selector('#icScaleToMatch', timeout=10000)

        # 1. Toggle must exist and default to ON (checked)
        toggle = page.query_selector('#icScaleToMatch')
        assert toggle is not None, "Scale to match toggle missing"
        assert toggle.is_checked(), "Scale to match must default to checked (ON)"

        # 2. Input test images A (640x360) and B (200x200)
        page.fill('#icPathA', '/tmp/test_cmp_a.png')
        page.dispatch_event('#icPathA', 'change')
        page.fill('#icPathB', '/tmp/test_cmp_b.png')
        page.dispatch_event('#icPathB', 'change')

        # Wait for dimension probing to resolve
        page.wait_for_function("document.getElementById('icDimA')?.textContent.includes('640')", timeout=5000)
        page.wait_for_function("document.getElementById('icDimB')?.textContent.includes('200')", timeout=5000)

        # Check that stage has .ic-scale-match by default
        stage_cls = page.get_attribute('#icStage', 'class') or ''
        assert 'ic-scale-match' in stage_cls, "Stage should have .ic-scale-match when toggle is ON"

        # In Separate mode with scaleToMatch=ON, both viewports have Image A's AR (640 / 360)
        ar_a = page.eval_on_selector('#icSepA', "el => el.style.getPropertyValue('--ic-ar')").strip()
        ar_b = page.eval_on_selector('#icSepB', "el => el.style.getPropertyValue('--ic-ar')").strip()
        assert '640' in ar_a and '360' in ar_a, f"icSepA unexpected AR: {ar_a}"
        assert '640' in ar_b and '360' in ar_b, f"icSepB should match Image A's AR when scaleToMatch is ON: {ar_b}"

        # Image elements should compute object-fit: fill
        img_fit = page.eval_on_selector('#icSepB img', "el => getComputedStyle(el).objectFit")
        assert img_fit == "fill", f"Expected object-fit fill when scaleToMatch ON, got {img_fit}"

        # 3. Switch to Overlay mode
        page.click('.img-compare-mode-btn[data-mode="overlay"]')
        page.wait_for_selector('#icMainViewport', timeout=5000)

        # Main viewport has Image A AR and image layers compute object-fit: fill
        main_ar = page.eval_on_selector('#icMainViewport', "el => el.style.getPropertyValue('--ic-ar')").strip()
        assert '640' in main_ar and '360' in main_ar, f"icMainViewport unexpected AR: {main_ar}"
        ref_fit = page.eval_on_selector('#icMainViewport .img-layer-ref', "el => getComputedStyle(el).objectFit")
        assert ref_fit == "fill", f"Expected ref layer object-fit fill, got {ref_fit}"

        # 4. Switch to A/B wipe mode
        page.click('.img-compare-mode-btn[data-mode="ab"]')
        page.wait_for_selector('#icMainViewport .img-compare-ab-handle', timeout=5000)
        ab_fit = page.eval_on_selector('#icMainViewport .img-layer-ref', "el => getComputedStyle(el).objectFit")
        assert ab_fit == "fill", f"Expected A/B wipe ref layer object-fit fill, got {ab_fit}"

        # 5. Uncheck Scale to match
        page.click('#icScaleToMatch')
        page.wait_for_timeout(200)

        assert not page.is_checked('#icScaleToMatch'), "toggle should be unchecked"
        stage_cls = page.get_attribute('#icStage', 'class') or ''
        assert 'ic-scale-match' not in stage_cls, "Stage should NOT have .ic-scale-match when toggle is OFF"

        # In A/B mode without scaleToMatch, images compute object-fit: contain
        ab_fit_off = page.eval_on_selector('#icMainViewport .img-layer-ref', "el => getComputedStyle(el).objectFit")
        assert ab_fit_off == "contain", f"Expected A/B ref layer object-fit contain when toggle is OFF, got {ab_fit_off}"

        # Switch back to Separate mode with toggle OFF
        page.click('.img-compare-mode-btn[data-mode="separate"]')
        page.wait_for_selector('#icSepA', timeout=5000)

        # In Separate mode with toggle OFF, icSepB uses its own native AR (200 / 200)
        ar_b_off = page.eval_on_selector('#icSepB', "el => el.style.getPropertyValue('--ic-ar')").strip()
        assert '200' in ar_b_off, f"icSepB should use native AR when scaleToMatch OFF: {ar_b_off}"
        img_fit_off = page.eval_on_selector('#icSepB img', "el => getComputedStyle(el).objectFit")
        assert img_fit_off == "contain", f"Expected object-fit contain when scaleToMatch OFF, got {img_fit_off}"

        # 6. Re-check Scale to match
        page.click('#icScaleToMatch')
        page.wait_for_timeout(200)
        assert page.is_checked('#icScaleToMatch'), "toggle should be checked again"
        ar_b_re = page.eval_on_selector('#icSepB', "el => el.style.getPropertyValue('--ic-ar')").strip()
        assert '640' in ar_b_re and '360' in ar_b_re, f"icSepB should match Image A AR again: {ar_b_re}"

        # 7. Test Swap button (⇄)
        page.click('#btnIcSwap')
        page.wait_for_timeout(300)
        # Now Image A is 200x200 and Image B is 640x360
        page.wait_for_function("document.getElementById('icDimA')?.textContent.includes('200')", timeout=5000)
        ar_swap_a = page.eval_on_selector('#icSepA', "el => el.style.getPropertyValue('--ic-ar')").strip()
        ar_swap_b = page.eval_on_selector('#icSepB', "el => el.style.getPropertyValue('--ic-ar')").strip()
        assert '200' in ar_swap_a, f"icSepA should be 200 after swap: {ar_swap_a}"
        assert '200' in ar_swap_b, f"icSepB should match new Image A AR (200) when scaleToMatch is ON: {ar_swap_b}"

        fatal = [e for e in errors if 'error' in e.lower() and 'compare' in e.lower()]
        assert not fatal, f"console errors from tab: {fatal}"
        browser.close()


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
