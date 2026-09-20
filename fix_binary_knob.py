import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# We need to find the SECOND instance of the big block and revert it.
# The big block is:
big_block = """
  const brick = document.getElementById(opts.hiddenId + 'Brick');
  if (brick) {
    function startEditing() {
      brick.classList.add('editing');
      valueDisplay.focus();
      valueDisplay.select();
    }
    brick.addEventListener('dblclick', startEditing);
    brick.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement === brick) {
        startEditing();
        e.preventDefault();
      }
    });
    valueDisplay.addEventListener('blur', () => {
      brick.classList.remove('editing');
      // trigger change on blur just in case
      const v = parseFloat(valueDisplay.value);
      if (!isNaN(v)) updateUI(v);
    });
    valueDisplay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = parseFloat(valueDisplay.value);
        if (!isNaN(v)) updateUI(v);
        brick.classList.remove('editing');
        brick.focus();
        e.preventDefault();
      }
    });
  }

  function onMouseDown(e) {"""

# Replace only the second occurrence.
parts = js.split(big_block)
if len(parts) == 3:
    js = parts[0] + big_block + parts[1] + "\n  function onMouseDown(e) {" + parts[2]

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)

