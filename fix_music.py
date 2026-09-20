import re

with open('mtapi-project/app/static/js/tabs/music.js', 'r') as f:
    js = f.read()

# Duration 12 -> 30
js = js.replace("st.duration ?? 12", "st.duration ?? 30")
js = js.replace("parseFloat(e.target.value || '12')", "parseFloat(e.target.value || '30')")

# BPM 0 -> -1
js = js.replace("st.bpm ?? '0'", "st.bpm ?? '-1'")
js = js.replace("min: 0, max: 300", "min: -1, max: 300")

# Seed random is already effectively -1 if left empty?
# Wait, let's look at seed.
js = js.replace("st.seed ?? '42'", "st.seed ?? '-1'")
js = js.replace("st.seed ?? 42", "st.seed ?? -1")
js = js.replace("min: 0, max: 4294967295", "min: -1, max: 4294967295")

# muShift 0.5 -> 3.0? No, shift default.
# The user wants muShift to default to 3
js = js.replace("st.shift ?? 3.0", "st.shift ?? 3")
js = js.replace("st.shift ?? '3.0'", "st.shift ?? '3'")

with open('mtapi-project/app/static/js/tabs/music.js', 'w') as f:
    f.write(js)
