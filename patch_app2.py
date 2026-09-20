import re

with open('mtapi-project/app/static/app.js', 'r') as f:
    js = f.read()

legacy_sync = """  window.globalInputs.video = (mode === 'video') ? mediaIn : '';
  window.globalInputs.image = (mode === 'image') ? mediaIn : '';
  window.globalInputs.pathIn = (mode === 'directory' || mode === 'audio' || mode === 'unknown') ? mediaIn : '';
  window.globalInputs.pathOut = mediaOut;

  // Sync to legacy DOM elements and fire input events for tabs that listen to them
  const legacyMap = {
      'giVideo': window.globalInputs.video,
      'giImage': window.globalInputs.image,
      'giPathIn': window.globalInputs.pathIn,
      'giPathOut': window.globalInputs.pathOut
  };
  for (const [id, val] of Object.entries(legacyMap)) {
      const el = document.getElementById(id);
      if (el) {
          if (el.value !== val) {
              el.value = val;
              el.dispatchEvent(new Event('input'));
          }
      }
  }
"""

js = re.sub(
    r'  window\.globalInputs\.video = \(mode === \'video\'\) \? mediaIn : \'\';\n  window\.globalInputs\.image = \(mode === \'image\'\) \? mediaIn : \'\';\n  window\.globalInputs\.pathIn = \(mode === \'directory\' \|\| mode === \'audio\' \|\| mode === \'unknown\'\) \? mediaIn : \'\';\n  window\.globalInputs\.pathOut = mediaOut;',
    legacy_sync,
    js,
    flags=re.DOTALL
)

with open('mtapi-project/app/static/app.js', 'w') as f:
    f.write(js)
