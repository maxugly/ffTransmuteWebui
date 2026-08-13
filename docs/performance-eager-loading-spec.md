# Performance & Eager Loading Spec

## 1. The Core Philosophy: RAM Over Disk
The system currently suffers from "lazy-loading fatigue." It scatters disk reads, SQLite queries, and `ffprobe` calls across various operations, causing the UI to stutter and feel sluggish during interactions.

**The Rule:** Do the heavy lifting *once* up front. Pay the time cost when the application or project first boots, load the global state into RAM (both backend Python memory and frontend JS memory), and make all subsequent user interactions instantaneously snappy.

## 2. Global Variants Registry (SQLite)
Currently, `/api/variants` is called lazily on a per-clip basis, causing a cascade of slow network requests and database hits.

**The Fix:**
- **Backend:** The backend must load the core mapping of the `variants.db` (Original Path -> Variant Paths + Multipliers) into a Python dictionary in RAM at server startup.
- **Frontend:** When the UI loads, it should make a *single* bulk API call to fetch the global variant map and store it in `state.globalVariants` (RAM).
- Any time the user drops a clip into the pool, the UI instantly checks its in-memory map. No network request, no disk read.

## 3. Media Metadata (`ffprobe`)
Currently, media probing is scattered and often re-triggered.

**The Fix:**
- When a folder or project is loaded, the backend should bulk-probe all unknown files concurrently and cache the results in the `index.json` (or equivalent RAM cache). 
- The frontend requests the bulk metadata once and keeps it in `state.pool.items[].meta`. 
- No more "waiting for probes to settle" during live UI interactions. If it's in the pool, its metadata is already in RAM.

## 4. Pool State Persistence
- As defined in the RIFE Robustness spec, `pool_state.json` must contain the absolute truth of the sequence (including all multipliers and metadata).
- Reading `pool_state.json` happens exactly once on page load. Saving happens asynchronously in the background. The user never waits on the disk.
