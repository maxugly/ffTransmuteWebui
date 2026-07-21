# AGENTS.md — Static WebUI Frontend Agent Directives

> **Scope**: Static web assets directory `/home/m/snc/cod/ffTransmuteWebui/mtapi-project/app/static`
> **Audience**: Autonomous AI Agents modifying WebUI components, styling, or client JS logic.

---

## 🎯 1. Mission & Design Directives

The frontend provides a fast, responsive interface for configuring complex ffmpeg and datamosh pipelines.

Agents editing frontend files MUST adhere to the project's web development standards:
- **Rich Aesthetics**: Dark mode, glassmorphism accents, crisp typography, and responsive controls.
- **Zero Build Step**: Native ES6 JS and CSS without Webpack, Vite, React, or Tailwind.
- **Direct REST Integration**: Interact with `/ops`, `/media/*`, `/health`, and `/openapi.json`.

---

## 🏗️ 2. Component Structure in `app.js`

- `fetchOperations()`: Fetches `/ops` registry schema and constructs operation navigation tabs.
- `renderForm(opSpec)`: Dynamically generates HTML inputs for `params_model` properties.
- `executeOp(id, payload)`: Sends POST request, updates execution status UI, and appends outputs to the media pool.
- `loadWorkspaceMedia()`: Fetches media items from `/media/workspace` and updates the media browser panel.

---

## 🔒 3. Front-End Invariants & Best Practices

1. **Path Normalization**:
   - Always pass full absolute file paths (e.g. `/home/m/...`) in API payloads.
2. **Handling `"ok": false` Responses**:
   - The API returns HTTP 200 even for operational failures. Check `data.ok === false` in `app.js` and display `data.error` / `data.stderr` in an error toast or terminal panel.
3. **Responsive Media Previews**:
   - Ensure video element sources point to `/media/file?path=...` or `/media/thumb?path=...` endpoints.
