import re

with open('mtapi-project/app/static/css/settings.css', 'r') as f:
    css = f.read()

# Fix settings-workspace max-width
css = re.sub(r'max-width:\s*520px;', 'max-width: 1200px;', css)

# Fix settings-grid columns
css = re.sub(r'grid-template-columns:\s*repeat\(auto-fill, minmax\(220px, 1fr\)\);', 'grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));', css)

# Fix settings-card width
css = re.sub(r'width:\s*max-content;', 'width: 100%; box-sizing: border-box;', css)

with open('mtapi-project/app/static/css/settings.css', 'w') as f:
    f.write(css)
