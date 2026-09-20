with open('mtapi-project/app/static/index.html', 'r') as f:
    html = f.read()
html = html.replace(
    '        <!-- Row 5: Frame range (kept from old) -->\\n (mosh + video-pipeline tabs: rife, deepdream, convert, …)\\n',
    '        <!-- Row 5: Frame range (mosh + video-pipeline tabs: rife, deepdream, convert, …)\\n'
)
with open('mtapi-project/app/static/index.html', 'w') as f:
    f.write(html)
