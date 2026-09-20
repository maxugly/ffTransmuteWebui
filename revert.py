import os
import re

js_dir = 'mtapi-project/app/static/js'

replacements = {
    "document.getElementById('giMediaIn')": "document.getElementById('giVideo')",
    "['giMediaIn'].forEach": "['giVideo', 'giImage'].forEach",
    "setVal('giMediaIn', window.globalInputs.video || window.globalInputs.image || window.globalInputs.pathIn);": "setVal('giVideo', window.globalInputs.video);\n  setVal('giImage', window.globalInputs.image);\n  setVal('giPathIn', window.globalInputs.pathIn);",
    "setVal('giMediaOut', window.globalInputs.pathOut);": "setVal('giPathOut', window.globalInputs.pathOut);"
}

def process_file(filepath):
    with open(filepath, 'r') as f:
        content = f.read()
    
    new_content = content
    for pattern, repl in replacements.items():
        new_content = new_content.replace(pattern, repl)
        
    if new_content != content:
        with open(filepath, 'w') as f:
            f.write(new_content)
        print(f"Reverted {filepath}")

for root, _, files in os.walk(js_dir):
    for file in files:
        if file.endswith('.js'):
            process_file(os.path.join(root, file))
