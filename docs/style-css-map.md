# F.1 style.css line range map

> For Track F.CSS extraction. Commit this first, then extract in order.

## Sections (top to bottom)

| extract # | file | lines | description |
|-----------|------|-------|-------------|
| — | — | 1–233 | root + globals + sidebar + header + global bar (keep in style.css as base) |
| F.2 | css/layout.css | 234–309, 344–363 | global bar, app workspace, action panel, preview/console panel |
| F.3 | css/forms.css | 409–681, 721–745 | interactive elements, inputs, sliders, toggles, buttons, cards |
| F.4 | css/console.css | 747–897, 949–1017 | media viewer, console terminal, mosh compare, modal styling |
| F.5 | css/modals.css | 949–1119 | file browser specifics (embedded in modal block, may overlap) |
| F.6 | css/pool.css | (TBD — pool styles mixed throughout) |
| F.7 | css/ops.css | (TBD — mosh timeline, watcher, datamosh, leftovers) |
| F.8 | — | delete empty style.css after all extractions |

Notes:
- Lines 1–233 (root, CSS variables, sidebar, header) stay in style.css as the monolithic base
- F.2–F.7 are extracted in order; after each extraction, verify with hard reload
- Pool styles and op-specific styles may span multiple ranges — refine during extraction
- F.8: after all extractions, remaining style.css should only have lines 1–233; delete if empty
