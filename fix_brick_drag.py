import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# 1. Update continuous knob onMouseDown
old_mousedown_cont = """  function onMouseDown(e) {
    knob.classList.add('active');
    startY = e.clientY;"""
new_mousedown_cont = """  function onMouseDown(e) {
    if (brick && brick.classList.contains('editing')) return;
    knob.classList.add('active');
    startY = e.clientY;"""
js = js.replace(old_mousedown_cont, new_mousedown_cont)

# 2. Update continuous knob event attachments
old_attach_cont = """  knob.addEventListener('mousedown', onMouseDown);
  knob.addEventListener('wheel', onWheel, { passive: false });
  // Wheel over the numeric readout also adjusts the knob
  valueDisplay.addEventListener('wheel', onWheel, { passive: false });"""
new_attach_cont = """  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('wheel', onWheel, { passive: false });
  valueDisplay.addEventListener('wheel', onWheel, { passive: false });"""
js = js.replace(old_attach_cont, new_attach_cont)

# 3. Update binary knob onMouseDown
old_mousedown_bin = """  function onMouseDown(e) {
    knob.classList.add('active');
    startX = e.clientX;"""
new_mousedown_bin = """  function onMouseDown(e) {
    knob.classList.add('active');
    startX = e.clientX;"""
js = js.replace(old_mousedown_bin, new_mousedown_bin)

# 4. Update binary knob event attachments
old_attach_bin = """  knob.addEventListener('mousedown', onMouseDown);
  knob.addEventListener('wheel', onWheel, { passive: false });"""
new_attach_bin = """  const brick = document.getElementById(opts.hiddenId + 'Brick');
  const target = brick || knob;
  target.addEventListener('mousedown', onMouseDown);
  target.addEventListener('wheel', onWheel, { passive: false });"""
js = js.replace(old_attach_bin, new_attach_bin)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
