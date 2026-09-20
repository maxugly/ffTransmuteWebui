import glob
import re

tabs_dir = 'mtapi-project/app/static/js/tabs'
files = glob.glob(f"{tabs_dir}/*.js")

html_defaults = {}

for file in files:
    with open(file, 'r') as f:
        content = f.read()
    
    # Extract knobUnitHtml defaults
    # regex for knobUnitHtml({ id: 'X', label: 'Y', value: 'Z'
    matches = re.finditer(r"knobUnitHtml\(\s*\{[^\}]*?id\s*:\s*['\"]([^'\"]+)['\"][^\}]*?value\s*:\s*(?:_saved\([^,]+,\s*)?['\"]([^'\"]+)['\"]", content)
    for m in matches:
        hid = m.group(1)
        val = m.group(2)
        html_defaults[hid] = val

print("| Tab | Knob ID | Default | Min | Max | Step | Decimals |")
print("| --- | ------- | ------- | --- | --- | ---- | -------- |")

for file in files:
    tab_name = file.split('/')[-1].replace('.js', '')
    with open(file, 'r') as f:
        content = f.read()
    
    # Simple regex for setupContinuousKnob fields
    matches = re.finditer(r'setupContinuousKnob\(\s*\{([^}]+)\}', content)
    for match in matches:
        opts_str = match.group(1)
        
        hid = re.search(r"hiddenId\s*:\s*(?:safeId|['\"]([^'\"]+)['\"])", opts_str)
        if not hid: continue
        # If safeId matched, it's dynamic, we skip or label
        hid = hid.group(1) if hid.group(1) else "DYNAMIC"
        
        min_v = re.search(r"min\s*:\s*([-0-9.]+)", opts_str)
        min_v = min_v.group(1) if min_v else ""
        
        max_v = re.search(r"max\s*:\s*([-0-9.]+)", opts_str)
        max_v = max_v.group(1) if max_v else ""
        
        step_v = re.search(r"step\s*:\s*([-0-9.]+)", opts_str)
        step_v = step_v.group(1) if step_v else ""
        
        dec_v = re.search(r"decimals\s*:\s*([0-9]+)", opts_str)
        dec_v = dec_v.group(1) if dec_v else ""
        
        default_v = html_defaults.get(hid, "??")
        
        print(f"| {tab_name} | {hid} | {default_v} | {min_v} | {max_v} | {step_v} | {dec_v} |")
