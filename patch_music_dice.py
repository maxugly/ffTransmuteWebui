import re

with open('mtapi-project/app/static/js/tabs/music.js', 'r') as f:
    js = f.read()

# 1. Update the 'seed' mapping in units definition
old_seed_map = """    seed: `<span class="mu-seed-wrap">${knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42) })}
      <button type="button" class="btn mu-dice" id="btnMuDice" title="Random seed">🎲</button></span>`,"""
new_seed_map = """    seed: knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42), dice: true }),"""
js = js.replace(old_seed_map, new_seed_map)

# 2. Update the seed knob in the explicit HTML view (top part of music.js)
old_seed_html = """        ${knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42) })}
        <button type="button" class="btn" id="btnMuDice" title="Random seed">🎲</button>"""
new_seed_html = """        ${knobUnitHtml({ id: 'muSeed', label: 'Seed', value: String(st.seed ?? 42), dice: true })}"""
js = js.replace(old_seed_html, new_seed_html)

# 3. Update the event listener
old_listener = """    document.getElementById('btnMuDice')?.addEventListener('click', () => {"""
new_listener = """    document.getElementById('btnmuSeedDice')?.addEventListener('click', (e) => {
      e.stopPropagation();"""
js = js.replace(old_listener, new_listener)

with open('mtapi-project/app/static/js/tabs/music.js', 'w') as f:
    f.write(js)
