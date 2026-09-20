import re

with open('mtapi-project/app/static/js/tabs/music.js', 'r') as f:
    js = f.read()

old_block = """    document.getElementById('btnmuSeedDice')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = Math.floor(Math.random() * 4294967296);"""

new_block = """    const diceBtn = document.getElementById('btnmuSeedDice');
    if (diceBtn) {
      diceBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      diceBtn.addEventListener('dblclick', (e) => e.stopPropagation());
      diceBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const n = Math.floor(Math.random() * 4294967296);"""

js = js.replace(old_block, new_block)

old_close = """      const ind = document.getElementById('muSeedKnobInd');
      if (ind) ind.style.transform = `translate(-50%, -100%) rotate(${-135 + (n / 4294967295) * 270}deg)`;
      _muState().seed = n;
    });"""

new_close = """      const ind = document.getElementById('muSeedKnobInd');
      if (ind) ind.style.transform = `translate(-50%, -100%) rotate(${-135 + (n / 4294967295) * 270}deg)`;
      _muState().seed = n;
      });
    }"""

js = js.replace(old_close, new_close)

with open('mtapi-project/app/static/js/tabs/music.js', 'w') as f:
    f.write(js)
