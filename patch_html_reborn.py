import re

with open('mtapi-project/app/static/index.html', 'r') as f:
    html = f.read()

# Replace header buttons
html = re.sub(
    r'<div class="global-quick-btns">.*?</div>',
    '<div class="global-quick-btns">\n        <button class="btn btn-quick" id="btnQuickI" title="Pick media input(s)">I</button>\n        <button class="btn btn-quick" id="btnQuickO" title="Pick output path">O</button>\n        <input type="hidden" id="giSecretIn">\n      </div>',
    html,
    flags=re.DOTALL
)

# Add Audio row after Image row
audio_row = """
        <!-- Row 2.5: Audio file(s) -->
        <div class="global-row" data-input="audio">
          <label>Audio file(s):</label>
          <textarea id="giAudio" rows="3" placeholder="One absolute path per line..." title="Type one absolute path per line. Use Browse to select multiple files at once." autocomplete="off" spellcheck="false" data-clearable></textarea>
          <button class="btn" id="btnGiAudioBrowse" title="Pick one or more audio files">Browse</button>
          <span class="gi-status" id="giAudioStatus" title=""></span>
        </div>"""

html = html.replace(
    '        <!-- Row 3: Path in -->',
    audio_row + '\n        <!-- Row 3: Path in -->'
)

with open('mtapi-project/app/static/index.html', 'w') as f:
    f.write(html)
