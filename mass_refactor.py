import os
import re

js_dir = 'mtapi-project/app/static/js'

# Replacements for straight DOM queries
replacements = {
    r"document\.getElementById\('giVideo'\)": "document.getElementById('giMediaIn')",
    r"document\.getElementById\('giImage'\)": "document.getElementById('giMediaIn')",
    r"document\.getElementById\('giPathIn'\)": "document.getElementById('giMediaIn')",
    r"document\.getElementById\('giPathOut'\)": "document.getElementById('giMediaOut')",
    r"\['giVideo', 'giImage'\]\.forEach": "['giMediaIn'].forEach",
    r"setVal\('giVideo', window\.globalInputs\.video\);\n\s*setVal\('giImage', window\.globalInputs\.image\);\n\s*setVal\('giPathIn', window\.globalInputs\.pathIn\);": "setVal('giMediaIn', window.globalInputs.video || window.globalInputs.image || window.globalInputs.pathIn);",
    r"setVal\('giPathOut', window\.globalInputs\.pathOut\);": "setVal('giMediaOut', window.globalInputs.pathOut);"
}

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    new_content = content
    for pattern, repl in replacements.items():
        new_content = re.sub(pattern, repl, new_content)
        
    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Patched {filepath}")

for root, _, files in os.walk(js_dir):
    for file in files:
        if file.endswith('.js'):
            process_file(os.path.join(root, file))
