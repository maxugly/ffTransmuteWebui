import re

with open('mtapi-project/app/static/index.html', 'r') as f:
    html = f.read()

# 1. Remove the old global-quick-btns completely
html = re.sub(
    r'<div class="global-quick-btns">.*?</div>',
    '',
    html,
    flags=re.DOTALL
)

# 2. Replace the global-inputs-inner with the new unified layout
new_inner = """<div class="global-inputs-inner unified-media-inputs" id="globalInputsInner">
        <!-- Row 1: Unified Media In -->
        <div class="global-row" data-input="mediaIn">
          <button class="btn btn-quick" id="btnQuickI" title="Pick media input(s)">I</button>
          <textarea id="giMediaIn" rows="1" placeholder="/absolute/path/in..." autocomplete="off" spellcheck="false" data-clearable></textarea>
          <span class="gi-status" id="giMediaInStatus" title=""></span>
        </div>
        <!-- Row 2: Unified Media Out -->
        <div class="global-row" data-input="mediaOut">
          <button class="btn btn-quick" id="btnQuickO" title="Pick output path">O</button>
          <textarea id="giMediaOut" rows="1" placeholder="/absolute/path/out..." autocomplete="off" spellcheck="false" data-clearable></textarea>
          <span class="gi-status" id="giMediaOutStatus" title=""></span>
        </div>
        <!-- Row 5: Frame range (kept from old) -->
"""

html = re.sub(
    r'<div class="global-inputs-inner" id="globalInputsInner">.*?<!-- Row 5: Frame range',
    new_inner,
    html,
    flags=re.DOTALL
)

with open('mtapi-project/app/static/index.html', 'w') as f:
    f.write(html)
