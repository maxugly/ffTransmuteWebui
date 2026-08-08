import asyncio
import subprocess
import time
from playwright.async_api import async_playwright

async def run_tests():
    server_proc = subprocess.Popen([".venv/bin/python", "-m", "uvicorn", "app.main:app", "--port", "8000"])
    try:
        await asyncio.sleep(3)
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page()
            page.on("console", lambda msg: print(f"Browser console: {msg.text}"))
            page.on("pageerror", lambda exc: print(f"Browser error: {exc}"))
            
            await page.goto("http://localhost:8000")
            await page.click("div[data-tab='imageedit']")
            await page.wait_for_selector("#ieEngine")
            
            await page.evaluate('''() => {
                const el = document.getElementById('giImage');
                el.value = '/tmp/fake_image.png';
                el.dispatchEvent(new Event('input'));
                el.dispatchEvent(new Event('change'));
            }''')
            
            await page.click("#btnAddOpScale")
            await page.click("#btnAddOpPad")
            await page.click("#btnAddOpCrop")
            
            await page.evaluate('''() => {
                document.getElementById('ieDryRun').value = '1';
                document.getElementById('ieDryRun').dispatchEvent(new Event('change'));
            }''')
            
            await page.click("#btnRun")
            
            try:
                await page.wait_for_function('''() => {
                    const body = document.getElementById('consoleBody');
                    return body && body.innerText.includes('dry run');
                }''', timeout=5000)
                output = await page.evaluate("document.getElementById('consoleBody').innerText")
                print("Output received:")
                print(output)
            except Exception as e:
                print(f"Timeout! Current console text: {await page.evaluate('document.getElementById(`consoleBody`)?.innerText')}")
    finally:
        server_proc.terminate()
        server_proc.wait()

if __name__ == "__main__":
    asyncio.run(run_tests())
