# Browser-free OpenVINO API

`vinoapi` is on this user's PATH through `~/.local/bin/vinoapi`, linked to the checkout's `bin/vinoapi`. Keep the checkout in its current location, or update the link after moving it. It uses the project virtual environment, the existing OpenVINO settings, model files, presets, authentication and memory cage. No browser, full WebUI server, installation workflow or new dependencies are needed.

- `vinoapi` (or `vinoapi run`): start the API, load the selected model, and show live status. Keep this terminal open. **Ctrl+C stops the API and releases the model.** There is no automatic restart or background service.
- `vinoapi model`: list installed models; enter a number to choose. Use a second terminal while the service is running. Switching unloads the old model and loads the new one. A failed load is reported; it does not silently restore the old model.
- `vinoapi model 'exact-model-id'`: select without the numbered prompt. Existing per-model tuning is preserved.
- `vinoapi status`: show the terminal-owned service's API address, PID, actual model phase, activity detail, available RAM and errors. An open API is not reported as a verified answer.
- `vinoapi stop`: ask the foreground launcher to stop and release its worker. Wait for its `API stopped; model released.` message.
- `vinoapi --cold`: start only the API and dashboard; load using `vinoapi model` or existing request auto-load behavior.

Choosing a model with no service running saves the choice for the next run without starting anything. With redirected input, `vinoapi model` lists models without prompting or changing selection. Models must already be downloaded and supported by the selected engine; HF discovery and downloads remain in the WebUI.

The displayed address is the saved bind address, normally `http://127.0.0.1:2431/v1`. Existing clients such as Cline can continue using it. This command does not change network exposure or API credentials.

Only one terminal launcher per settings file can run. A private local control socket accepts model/status/stop commands; it does not expose credentials. Startup refuses to reclaim another launcher's API port. Stop an existing WebUI-owned worker before starting the CLI. Avoid running both launchers together: they share settings and model resources.

Validation: repository gate green, seven focused tests (selection, tuning preservation, unavailable models, status, private control socket, lifecycle), and real CLI cold startup/status/list/stop. The real worker used about 52 MB with no weights loaded. Ports 2431 and 24590 were closed afterward. No new live generation test was performed for this launcher; it delegates loading and inference to the existing tested supervisor and worker.
