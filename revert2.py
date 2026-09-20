import os

js_dir = 'mtapi-project/app/static/js'

replacements = {
    "document.getElementById('giMediaOut')": "document.getElementById('giPathOut')"
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
