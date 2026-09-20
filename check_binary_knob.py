import os
import re
import glob

tabs_dir = 'mtapi-project/app/static/js/tabs'
files = glob.glob(f"{tabs_dir}/*.js")

for file in files:
    with open(file, 'r') as f:
        content = f.read()
    
    matches = re.finditer(r'setupBinaryKnob\(\s*\{([^}]+)\}', content)
    for i, match in enumerate(matches):
        opts_str = match.group(1)
        if 'hiddenId' not in opts_str or 'leftValue' not in opts_str or 'rightValue' not in opts_str:
            print(f"MISSING attr in {file}, call #{i+1}:")
            print(opts_str.strip())
            print("-" * 40)
