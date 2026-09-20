import re

with open('mtapi-project/app/static/css/forms.css', 'r') as f:
    css = f.read()

new_styles = """
/* Brick Knob UI */
.knob-unit {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 10px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  width: 72px; 
  height: 96px; 
  box-sizing: border-box;
  transition: border-color 0.15s ease, background 0.15s ease;
  cursor: ns-resize;
  outline: none;
  position: relative;
}
.knob-unit:hover {
  background: rgba(255, 255, 255, 0.05);
}
.knob-unit:focus {
  border-color: var(--primary);
  background: rgba(59, 130, 246, 0.1);
}
.knob-unit-label {
  font-size: 0.65rem;
  color: #94a3b8;
  margin-bottom: 6px;
  text-align: center;
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  width: 100%;
}
.knob-unit .daw-knob {
  margin: 0;
  width: 48px;
  height: 48px;
  position: relative;
  flex-shrink: 0;
  cursor: ns-resize;
}
.knob-unit .daw-knob-value-display {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  font-size: 0.75rem;
  font-weight: 600;
  color: #fff;
  pointer-events: none;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
  z-index: 2;
  transition: opacity 0.1s;
}
.knob-unit .daw-knob-value-input {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 40px; margin: 0 !important;
  text-align: center;
  font-size: 0.75rem;
  font-weight: 600;
  color: #fff;
  background: #0f172a;
  border: 1px solid var(--primary);
  border-radius: 3px;
  z-index: 3;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s;
}
.knob-unit.editing .daw-knob-value-input {
  opacity: 1;
  pointer-events: auto;
  cursor: text;
}
.knob-unit.editing .daw-knob-value-display {
  opacity: 0;
}
/* For binary knobs */
.knob-unit .binary-knob-caption {
  margin-top: 4px;
  width: 100%;
}
.knob-unit:has(.binary-knob) {
  cursor: pointer;
}
.daw-knob.binary-knob {
  cursor: pointer !important;
}
"""

if "/* Brick Knob UI */" not in css:
    with open('mtapi-project/app/static/css/forms.css', 'w') as f:
        f.write(css + "\n" + new_styles)
