import glob

def find_closing_bracket(text, start_index):
    count = 1
    in_str = False
    str_char = ''
    
    for i in range(start_index, len(text)):
        char = text[i]
        
        if in_str:
            if char == str_char and text[i-1] != '\\':
                in_str = False
            continue
            
        if char in ["'", '"', '`']:
            in_str = True
            str_char = char
            continue
            
        if char == '{':
            count += 1
        elif char == '}':
            count -= 1
            if count == 0:
                return i
    return -1

tabs_dir = 'mtapi-project/app/static/js/tabs'
files = glob.glob(f"{tabs_dir}/*.js")

for file in files:
    with open(file, 'r') as f:
        content = f.read()
    
    start = 0
    while True:
        idx = content.find('setupContinuousKnob({', start)
        if idx == -1:
            break
        
        obj_start = idx + len('setupContinuousKnob({')
        obj_end = find_closing_bracket(content, obj_start)
        
        if obj_end != -1:
            opts_str = content[obj_start:obj_end]
            if 'valueId' not in opts_str:
                print(f"MISSING valueId in {file}:")
                print(opts_str.strip())
                print("-" * 40)
        
        start = idx + 1
