# Model Manager (Phase 4)

> **Status:** Specification Phase

## 1. What This Replaces
Currently, every neural operation loads its own model instance independently. `deepdream_engine` loads Inception, `styletransfer` loads Magenta, and `withoutbg` loads its own weights. If two operations run back-to-back, their respective models unload and reload, which is extremely wasteful in terms of compute, I/O, and time. Furthermore, concurrent operations risk OOM (Out Of Memory) errors because there is no unified GPU memory accounting. The Model Manager centralizes model loading, pooling, and eviction to solve these issues.

## 2. Shared Model Registry
A central registry (`app/model_manager.py`) responsible for instantiating and holding neural models in memory.
- **Load Once:** Models are loaded into a shared pool. Subsequent requests for the same model return the cached instance.
- **Reference Counting:** The registry tracks how many active jobs are using a model to prevent it from being unloaded while in use.
- **LRU Eviction:** When memory limits are reached, the least recently used model (with a reference count of 0) is evicted from GPU/system memory to make room for new models.

## 3. GPU Memory Budgeting
To prevent OOM crashes when large models (like DeepDream and StyleTransfer) are requested simultaneously, the manager implements a memory budget.
- Each model defines an estimated memory footprint requirement upon registration (e.g., `InceptionV3: 2GB`, `Magenta: 1.5GB`).
- The manager maintains a running total of allocated GPU memory.
- If a new model request exceeds the predefined budget, the manager attempts to aggressively evict idle models until sufficient budget is available. 
- If no models can be evicted (all are actively in use), the job waits or is gracefully queued instead of causing a hard crash.

## 4. Warm vs. Cold Lifecycle
Models support distinct lifecycle strategies depending on usage frequency:
- **Lazy Load (Cold):** By default, a model is loaded on the first request. This saves memory on startup but incurs a loading penalty on the first run.
- **Preload (Warm):** Frequently used or lightweight models can be flagged for preloading during server startup (e.g., in `run.py`). This guarantees zero initialization latency for the first request.
- Configurable via an environment variable or config file (e.g., `PRELOAD_MODELS="withoutbg,facemorph"`).

## 5. Integration with filter_fn
The current pattern where engines load their own weights inside the filter or processing loop is deprecated.
- **Model as Context:** The model instance is retrieved from the Model Manager *before* the pipeline begins processing frames.
- The pipeline or the engine injects the loaded model reference into the `filter_fn` closure or context object.
- **Example pattern:**
  ```python
  async with model_manager.acquire("deepdream_inception") as model:
      # model is guaranteed to stay in memory inside this block (ref count + 1)
      async def my_filter(input_png, output_png, index):
          # Use the pre-loaded `model` reference here
          pass
      await pipeline.process(workspace, my_filter)
  ```
- This ensures the `filter_fn` signature remains simple and strictly focused on frame I/O, while the model lifecycle is cleanly decoupled.

## 6. Acceptance Criteria
- **AC-1:** Given two consecutive requests for the same neural operation, When the second request starts, Then the model is not reloaded from disk, resulting in faster execution.
- **AC-2:** Given a strictly limited memory budget, When two heavy operations are requested that exceed the budget, Then the second operation waits or is queued instead of causing a CUDA OOM crash.
- **AC-3:** Given an idle model with a reference count of 0, When the memory budget is exhausted by a new model request, Then the idle model is evicted (unloaded) to free memory.
- **AC-4:** Given a server configured with `PRELOAD_MODELS`, When the server starts, Then the specified models are loaded into memory before the first HTTP request is served.
- **AC-5:** Given a filter function running via the `VideoPipeline`, When it processes a frame, Then it uses the model reference passed in from the outer context without invoking any load/unload logic itself.
