import re

with open('mtapi-project/app/static/js/tabs/music.js', 'r') as f:
    js = f.read()

profile_logic = """
    // Apply model profiles dynamically
    const v = e.target.value.toLowerCase();
    let steps = 50, guide = 5;
    if (v.includes('turbo') || v.includes('lcm') || v.includes('lightning') || v.includes('fast')) {
      steps = 25; guide = 3.5;
    } else if (v.includes('quality') || v.includes('hd') || v.includes('large')) {
      steps = 100; guide = 7;
    }
    
    function setKnob(id, newVal) {
      const el = document.getElementById(id);
      const valEl = document.getElementById(id + 'Val');
      if (el) el.setAttribute('data-default', newVal);
      if (valEl) {
        valEl.value = newVal;
        valEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    
    // We update state because music.js relies on it during re-render
    _muState().steps = steps;
    _muState().guidance = guide;
"""

# Insert inside the change listener before `renderMusicForm()`
insert_target = "    renderMusicForm();"
# We only want to replace the first occurrence inside the model change listener.
# Let's be precise. 
js = js.replace("    _muState().task = 'text2music';\n    renderMusicForm();", "    _muState().task = 'text2music';\n" + profile_logic + "\n    renderMusicForm();")

with open('mtapi-project/app/static/js/tabs/music.js', 'w') as f:
    f.write(js)
