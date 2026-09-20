import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

# Add safety check in solveX and solveS for division by zero
js = js.replace("if (curve === 'lin') {", "if (s1 === s0) return x0;\n  if (curve === 'lin') {")
# for solveS
js = js.replace("let pct = (x - x0) / dx;", "if (dx === 0 || s1 === s0) return s0;\n  let pct = (x - x0) / dx;")

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
