import os
import re
import glob

tabs_dir = 'mtapi-project/app/static/js/tabs'
files = glob.glob(f"{tabs_dir}/*.js")

for file in files:
    with open(file, 'r') as f:
        content = f.read()
    
    # Find all setupContinuousKnob calls
    # We'll use a regex that captures the contents of the object
    matches = re.finditer(r'setupContinuousKnob\(\s*\{([^}]+)\}', content)
    for i, match in enumerate(matches):
        opts_str = match.group(1)
        if 'valueId' not in opts_str:
            print(f"MISSING valueId in {file}, call #{i+1}:")
            print(opts_str.strip())
            print("-" * 40)
