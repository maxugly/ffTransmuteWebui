import re

with open('mtapi-project/app/static/css/forms.css', 'r') as f:
    css = f.read()

css += """
.knob-reset-btn {
  position: absolute;
  top: 4px;
  left: 4px;
  width: 14px;
  height: 14px;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.2);
  font-size: 10px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
  transition: color 0.15s, background 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}
.knob-reset-btn:hover {
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
}
.knob-dice-btn {
  position: absolute;
  bottom: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  background: transparent;
  border: none;
  font-size: 12px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
  transition: transform 0.1s;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5;
}
.knob-dice-btn:hover {
  transform: scale(1.1);
}
"""

with open('mtapi-project/app/static/css/forms.css', 'w') as f:
    f.write(css)
