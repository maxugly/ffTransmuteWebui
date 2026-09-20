import re

with open('mtapi-project/app/static/js/ui/knobs.js', 'r') as f:
    js = f.read()

new_math = """const S_MIN = 1.0;

function solveX(s, curve, s0, s1, x0, dx) {
  let pct = 0;
  if (curve === 'lin') {
    pct = (s - s0) / (s1 - s0);
  } else if (curve === 'log10') {
    pct = Math.log(s / s0) / Math.log(s1 / s0);
  } else if (curve === 'log2') {
    let norm = (s - s0) / (s1 - s0);
    pct = Math.log2(norm * 1023 + 1) / 10.0;
  }
  return x0 + Math.max(0, Math.min(1, pct)) * dx;
}

function solveS(x, curve, s0, s1, x0, dx) {
  let pct = (x - x0) / dx;
  pct = Math.max(0, Math.min(1, pct));
  if (curve === 'lin') {
    return s0 + pct * (s1 - s0);
  } else if (curve === 'log10') {
    return s0 * Math.pow(s1 / s0, pct);
  } else if (curve === 'log2') {
    return s0 + (s1 - s0) * (Math.pow(2, 10 * pct) - 1) / 1023.0;
  }
}

function getSensX(s) {
  let botC = window.state?.settings?.knobBotCurve || 'log10';
  let topC = window.state?.settings?.knobTopCurve || 'lin';
  let mid = parseFloat(window.state?.settings?.knobMidSet || 100);
  let max = parseFloat(window.state?.settings?.knobMax || 125);
  
  if (s <= mid) return solveX(s, botC, S_MIN, mid, 0, 1000);
  return solveX(s, topC, mid, max, 1000, 1000);
}

function getSensFromX(x) {
  let botC = window.state?.settings?.knobBotCurve || 'log10';
  let topC = window.state?.settings?.knobTopCurve || 'lin';
  let mid = parseFloat(window.state?.settings?.knobMidSet || 100);
  let max = parseFloat(window.state?.settings?.knobMax || 125);
  
  if (x <= 1000) return solveS(x, botC, S_MIN, mid, 0, 1000);
  return solveS(x, topC, mid, max, 1000, 1000);
}
"""

js = re.sub(r"function getSensX\(s\).*?function getSensFromX\(x\) {.*?}\n", new_math, js, flags=re.DOTALL)

with open('mtapi-project/app/static/js/ui/knobs.js', 'w') as f:
    f.write(js)
