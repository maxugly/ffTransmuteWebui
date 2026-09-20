import re

with open('mtapi-project/app/static/index.html', 'r') as f:
    html = f.read()

# 1. Update Header Buttons
html = re.sub(
    r'<div class="global-quick-btns">.*?</div>',
    '<div class="global-quick-btns">\n        <button class="btn btn-quick" id="btnQuickI" title="Pick media input(s)">I</button>\n        <button class="btn btn-quick" id="btnQuickO" title="Pick output path">O</button>\n      </div>',
    html,
    flags=re.DOTALL
)

# 2. Replace Panel Rows (video, image, audio, pathIn, pathOut) with just mediaIn and mediaOut
panel_inner_regex = r'<div class="global-inputs-inner".*?id="globalInputsInner">.*?<!-- Row 5:'
unified_rows = """<div class="global-inputs-inner unified-media-inputs" id="globalInputsInner">
        <!-- Unified Media In -->
        <div class="global-row" data-input="mediaIn">
          <label>Media In:</label>
          <textarea id="giMediaIn" rows="2" placeholder="/absolute/path/in..." autocomplete="off" spellcheck="false" data-clearable></textarea>
          <span class="gi-status" id="giMediaInStatus" title=""></span>
        </div>
        <!-- Unified Media Out -->
        <div class="global-row" data-input="mediaOut">
          <label>Media Out:</label>
          <textarea id="giMediaOut" rows="1" placeholder="/absolute/path/out..." autocomplete="off" spellcheck="false" data-clearable></textarea>
          <span class="gi-status" id="giMediaOutStatus" title=""></span>
        </div>
        <!-- Row 5:"""

html = re.sub(panel_inner_regex, unified_rows, html, flags=re.DOTALL)

with open('mtapi-project/app/static/index.html', 'w') as f:
    f.write(html)
