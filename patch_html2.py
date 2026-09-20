import re

with open('mtapi-project/app/static/index.html', 'r') as f:
    html = f.read()

# Fix the broken comment
html = html.replace(
    '        <!-- Row 5: Frame range (kept from old) -->\\n (mosh + video-pipeline tabs: rife, deepdream, convert, …)\\n',
    '        <!-- Row 5: Frame range (mosh + video-pipeline tabs: rife, deepdream, convert, …)\\n'
)

# Insert the legacy hidden inputs right before giFramesRow
legacy_hidden = """
        <textarea id="giVideo" style="display:none"></textarea>
        <textarea id="giImage" style="display:none"></textarea>
        <input type="text" id="giPathIn" style="display:none">
        <input type="text" id="giPathOut" style="display:none">
        <span id="giVideoStatus" style="display:none"></span>
        <span id="giImageStatus" style="display:none"></span>
        <span id="giPathInStatus" style="display:none"></span>
        <span id="giPathOutStatus" style="display:none"></span>
"""

html = html.replace(
    '        <div class="global-row" data-input="frames" id="giFramesRow" style="display:none">',
    legacy_hidden + '\\n        <div class="global-row" data-input="frames" id="giFramesRow" style="display:none">'
)

with open('mtapi-project/app/static/index.html', 'w') as f:
    f.write(html)
