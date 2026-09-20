import re

with open('mtapi-project/app/static/js/pool/persistence.js', 'r') as f:
    js = f.read()

# in applyDeskSnapshot, skip form state if not state.settings.restoreSession
# wait, how to access state? It's global `state`.
# Wait, let's see how `applyDeskSnapshot` reads.
old = "if (desk.form_state && typeof desk.form_state === 'object') state.formState = desk.form_state;"
new = """if (desk.form_state && typeof desk.form_state === 'object' && state.settings?.restoreSession !== false) state.formState = desk.form_state;"""
js = js.replace(old, new)

old_s = "const s = hydrateDeskTabs(desk.state || {});"
new_s = "const s = state.settings?.restoreSession !== false ? hydrateDeskTabs(desk.state || {}) : {};"
js = js.replace(old_s, new_s)

# skip global_inputs? "give us defaults or not" Usually yes, a fresh slate.
# But `gi` is parsed before `state.settings`? No, state.settings is already populated by `applySettingsPrecedence()` at startup!
old_gi = """  const gi = desk.global_inputs || {};
  window.globalInputs.video = gi.video || '';"""
new_gi = """  const gi = state.settings?.restoreSession !== false ? (desk.global_inputs || {}) : {};
  window.globalInputs.video = gi.video || '';"""
js = js.replace(old_gi, new_gi)

with open('mtapi-project/app/static/js/pool/persistence.js', 'w') as f:
    f.write(js)
