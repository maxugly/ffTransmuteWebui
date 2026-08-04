import { state, elements, bestInput, logConsole } from '/app.js';
import { setupContinuousKnob, setupBinaryKnob, knobUnitHtml } from '/js/ui/knobs.js';
import {
  evolveRifeModelSelectHtml,
  evolveRifeKnobUnitsHtml,
  setupEvolveRifeKnobs,
  collectEvolveRifeFields,
  setupEvolveMasterToggle,
} from '/js/ui/evolve-rife.js';
import { withFrameRange } from '/js/utils.js';

// ── DeepDream tab ─────────────────────────────────────────────────────────

/** Real nets + their custom-knob layers (must match deepdream_engine.py). */
const DREAM_MODELS = {
  inception_v3: {
    label: 'InceptionV3 (ImageNet) — classic Google DeepDream',
    layers: [
      { id: 'mixed0', label: 'mixed0', def: 0 },
      { id: 'mixed1', label: 'mixed1', def: 0 },
      { id: 'mixed2', label: 'mixed2', def: 0 },
      { id: 'mixed3', label: 'mixed3', def: 0 },
      { id: 'mixed4', label: 'mixed4', def: 1.0 },
      { id: 'mixed5', label: 'mixed5', def: 1.5 },
      { id: 'mixed6', label: 'mixed6', def: 2.0 },
      { id: 'mixed7', label: 'mixed7', def: 2.5 },
      { id: 'mixed8', label: 'mixed8', def: 0 },
      { id: 'mixed9', label: 'mixed9', def: 0 },
      { id: 'mixed10', label: 'mixed10', def: 0 },
    ],
    presets: {
      shallow: 'Shallow — mixed3–4 (fine textures)',
      mid: 'Mid — mixed4–6',
      deep: 'Deep — mixed5–7 (large forms)',
      classic: 'Classic — mixed4–7 (Google-style)',
      full: 'Full — mixed3–7',
      custom: 'Custom weights (knobs below)',
    },
  },
  vgg16: {
    label: 'VGG16 (ImageNet) — hierarchical / classic NN dream look',
    layers: [
      { id: 'block2_conv2', label: 'b2c2', def: 0 },
      { id: 'block3_conv3', label: 'b3c3', def: 0.5 },
      { id: 'block4_conv3', label: 'b4c3', def: 1.0 },
      { id: 'block5_conv1', label: 'b5c1', def: 1.5 },
      { id: 'block5_conv2', label: 'b5c2', def: 0 },
      { id: 'block5_conv3', label: 'b5c3', def: 2.0 },
    ],
    presets: {
      shallow: 'Shallow — block2–3 (edges / textures)',
      mid: 'Mid — block3–4',
      deep: 'Deep — block4–5 (objects / eyes)',
      classic: 'Classic — block3/4/5 mix',
      full: 'Full — block2–5',
      custom: 'Custom weights (knobs below)',
    },
  },
  resnet50: {
    label: 'ResNet50 (ImageNet) — residual features, different "creatures"',
    layers: [
      { id: 'conv2_block3_out', label: 'c2b3', def: 0 },
      { id: 'conv3_block4_out', label: 'c3b4', def: 0.8 },
      { id: 'conv4_block1_out', label: 'c4b1', def: 1.0 },
      { id: 'conv4_block6_out', label: 'c4b6', def: 1.5 },
      { id: 'conv5_block3_out', label: 'c5b3', def: 2.0 },
    ],
    presets: {
      shallow: 'Shallow — conv2–3',
      mid: 'Mid — conv3–4',
      deep: 'Deep — conv4–5',
      classic: 'Classic — conv3/4/5 mix',
      full: 'Full — conv2–5',
      custom: 'Custom weights (knobs below)',
    },
  },
};

function renderDeepDreamForm() {
  const html = `
    <div class="panel-title-desc dense">
      <h3>Google DeepDream</h3>
      <p class="dream-hint">CNN gradient ascent — pick model + layers. Image / video / Ouroboros.</p>
    </div>

    <div class="form-row">
      <label for="dreamInput">Input</label>
      <div class="input-row">
        <input type="text" id="dreamInput" placeholder="image.png or video.mp4">
        <button class="btn" type="button" id="btnDreamBrowseIn">Browse</button>
      </div>
    </div>
    <div class="form-row">
      <label for="dreamOutput">Output</label>
      <div class="input-row">
        <input type="text" id="dreamOutput" placeholder="blank = auto next to source">
        <button class="btn" type="button" id="btnDreamBrowseOut">Save As</button>
      </div>
    </div>
    <div class="form-row">
      <label for="dreamGuide">Guide</label>
      <div class="input-row">
        <input type="text" id="dreamGuide" placeholder="optional — steer features (blank = classic L2)">
        <button class="btn" type="button" id="btnDreamBrowseGuide">Browse</button>
      </div>
      <p class="form-row-hint">Match activations to guide (flowers → floral, faces → face-like…)</p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamMedia', label: 'Media', value: 'auto', binary: true, leftCap: 'Image', rightCap: 'Video' })}
        ${knobUnitHtml({ id: 'dreamAutoDetect', label: 'Detect', value: '1', binary: true, leftCap: 'Force', rightCap: 'Auto' })}
        ${knobUnitHtml({ id: 'dreamJitter', label: 'Jitter', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'dreamDetail', label: 'Detail', value: '1', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'dreamAudio', label: 'Audio', value: '1', binary: true, leftCap: 'Drop', rightCap: 'Keep' })}
        ${knobUnitHtml({ id: 'dreamDryRun', label: 'Dry run', value: '0', binary: true, leftCap: 'Run', rightCap: 'Dry' })}
      </div>
      <p class="knob-row-legend">Detect=Auto uses extension. Force uses Media knob.</p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamStep', label: 'Step', value: '0.01' })}
        ${knobUnitHtml({ id: 'dreamIters', label: 'Iterations', value: '20' })}
        ${knobUnitHtml({ id: 'dreamOctaves', label: 'Octaves', value: '3' })}
        ${knobUnitHtml({ id: 'dreamOctScale', label: 'Oct scale', value: '1.4' })}
        ${knobUnitHtml({ id: 'dreamMaxLoss', label: 'Max loss', value: '0' })}
        ${knobUnitHtml({ id: 'dreamBlend', label: 'Blend', value: '1.0' })}
        ${knobUnitHtml({ id: 'dreamPreviewW', label: 'Preview W', value: '0' })}
      </div>
      <p class="knob-row-legend">Ascent knobs. Preview W 0 = full width.</p>
    </div>

    <div class="form-row">
      <label for="dreamModel">Model</label>
      <select id="dreamModel">
        <option value="inception_v3" selected>InceptionV3 — classic</option>
        <option value="vgg16">VGG16 — hierarchical</option>
        <option value="resnet50">ResNet50 — residual</option>
      </select>
      <label for="dreamLayerPreset">Layers</label>
      <select id="dreamLayerPreset"></select>
      <p class="form-row-hint">Real architectures (weights may download once). Preset maps to that net’s layers.</p>
    </div>

    <div class="dream-section-title dream-layer-weights" id="dreamLayerWeightsTitle">Custom layer weights</div>
    <div class="knob-bank dream-layer-weights" id="dreamLayerWeightsBank"></div>

    <div class="knob-row dream-video-only" id="dreamVideoBank">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamFrameStep', label: 'Frame step', value: '1' })}
        ${knobUnitHtml({ id: 'dreamMaxFrames', label: 'Max frames', value: '0' })}
        ${knobUnitHtml({ id: 'dreamTemporalBlend', label: 'Temporal blend', value: '0.85' })}
        ${knobUnitHtml({ id: 'dreamOpticalFlow', label: 'Optical flow', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
        ${knobUnitHtml({ id: 'dreamLayerCycle', label: 'Layer cycle', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      </div>
      <p class="knob-row-legend dream-video-only">
        <strong>Temporal blend</strong> 0.85 classic · 1 = off.
        <strong>Optical flow</strong> warps residual (ignores blend when on).
        <strong>Layer cycle</strong> = one layer/frame. Step &gt; 1 holds last dream.
      </p>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamOuro', label: 'Ouroboros', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      </div>
      <p class="knob-row-legend">Still → dream → transform → feedback loop (writes video).</p>
    </div>
    <div class="dream-ouro-only" id="dreamOuroPanel">
      <div class="form-row">
        <label for="dreamFrameTransform">Transform</label>
        <select id="dreamFrameTransform">
          <option value="zoom_rotate" selected>Zoom + Spin</option>
          <option value="zoom">Zoom only</option>
          <option value="rotate">Spin only</option>
          <option value="translate">Translate</option>
          <option value="none">None</option>
        </select>
      </div>
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'dreamOuroLen', label: 'Frames', value: '30' })}
          ${knobUnitHtml({ id: 'dreamOuroFps', label: 'FPS', value: '30' })}
          ${knobUnitHtml({ id: 'dreamZoom', label: 'Zoom', value: '1.04' })}
          ${knobUnitHtml({ id: 'dreamSpin', label: 'Spin °', value: '1.5' })}
          ${knobUnitHtml({ id: 'dreamTx', label: 'Pan X', value: '5' })}
          ${knobUnitHtml({ id: 'dreamTy', label: 'Pan Y', value: '5' })}
        </div>
        <p class="knob-row-legend">
          Zoom &gt; 1 in/frame · Spin °/frame · Translate +X/+Y pan (default 5px). Scales with FPS.
        </p>
      </div>
    </div>

    <div class="knob-row">
      <div class="knob-bank">
        ${knobUnitHtml({ id: 'dreamEvolve', label: 'Evolve', value: '0', binary: true, leftCap: 'Off', rightCap: 'On' })}
      </div>
      <p class="knob-row-legend">
        Capture mid-ascent frames → drop near-dups (Image Sort metrics) → optional RIFE →
        <code>*_dream_evolve.mp4</code> (still export unchanged).
      </p>
    </div>
    <div class="dream-evolve-only hidden" id="dreamEvolvePanel">
      <div class="form-row">
        <label for="dreamEvolveMetric">Metric</label>
        <select id="dreamEvolveMetric">
          <option value="phash" selected>pHash — structure (default thr 4)</option>
          <option value="ahash">aHash — coarse brightness</option>
          <option value="colorhash">colorhash — palette</option>
          <option value="mse">MSE — pixel distance</option>
          <option value="ssim">SSIM distance (if installed)</option>
        </select>
      </div>
      ${evolveRifeModelSelectHtml('dreamEvolve')}
      <div class="knob-row">
        <div class="knob-bank">
          ${knobUnitHtml({ id: 'dreamEvolveFps', label: 'FPS', value: '12' })}
          ${knobUnitHtml({ id: 'dreamEvolveThr', label: 'Min dist', value: '4' })}
          ${knobUnitHtml({ id: 'dreamEvolveCapN', label: 'Every N', value: '0' })}
          ${evolveRifeKnobUnitsHtml('dreamEvolve')}
        </div>
        <p class="knob-row-legend">
          <strong>Min dist</strong> 0 = keep all · pHash ~4 default · higher = fewer frames.
          <strong>Every N</strong> 0 = live cadence · else every N ascent publishes.
          <strong>RIFE</strong> fills between kept keyframes (shared UI + bookend).
        </p>
      </div>
    </div>

    <section class="tool-docs" aria-label="About DeepDream">
      <h4 class="tool-docs-title">About · DeepDream</h4>
      <p class="tool-docs-lede">
        <strong>DeepDream</strong> is reverse engineering of a vision network’s imagination.
        You start from a real photo or video frame. A CNN (trained on ImageNet to recognize
        dogs, buildings, textures…) looks at the pixels and lights up internal “feature”
        maps. Instead of asking “what is this?”, we <em>maximize</em> those activations —
        gradient ascent on the image itself — so the pixels morph until the net “sees”
        more of whatever patterns that layer cares about. Edges become eyes, bark becomes
        fur, clouds become architecture. That is the classic 2015 Google look.
      </p>
      <p class="tool-docs-lede">
        This tab runs that idea three ways: <strong>still image</strong> (one dream),
        <strong>video</strong> (dream every frame, with options so the trip stays coherent
        across time), and <strong>Ouroboros</strong> (dream a still → warp it → feed the
        result back → write a clip). Video uses the filter platform
        (dump → per-frame dream → encode). First ImageNet weight download can take a while;
        after that, cost is mostly GPU/CPU per frame × octaves × iterations.
      </p>

      <h5 class="tool-docs-h">If you are new — try this first</h5>
      <ol class="tool-docs-ol">
        <li>Put a <strong>still</strong> in Input (or the global Image bar). Leave Ouroboros <strong>Off</strong>.</li>
        <li>Model <strong>InceptionV3</strong>, Layers <strong>Classic</strong>.</li>
        <li>Leave defaults: Step 0.01, Iterations 20, Octaves 3, Jitter/Detail On.</li>
        <li>Optional: set <strong>Preview W</strong> to ~640 for a faster test render.</li>
        <li>Run. If it is too mild, raise Iterations or use Layers <strong>Deep</strong>.
            If it is pure noise soup, lower Step, or use <strong>Shallow</strong> layers.
            Leave <strong>Max loss off</strong> unless you know Inception-scale losses.</li>
      </ol>

      <h5 class="tool-docs-h">Paths</h5>
      <dl class="tool-docs-dl">
        <dt>Input</dt>
        <dd>Absolute path to a still (PNG/JPG/…) or video (MP4/…). Blank local field falls back to the global Video/Image bar.</dd>
        <dt>Output</dt>
        <dd>Where to write. Blank = next to the source (<code>*_dream.png</code> / <code>*_dream.mp4</code> / <code>*_ouroboros.mp4</code>).</dd>
        <dt>Guide (optional)</dt>
        <dd>A second still whose <em>features</em> steer the dream. Blank = classic L2
          “amplify whatever is already firing.” With a guide, ascent tries to match the
          guide’s activations — flowers push floral textures, a face pushes face-like
          structure. Guide is not a paste/composite; it is a target in feature space.
          Works best as a clear photo, not a blank or pure noise.</dd>
      </dl>

      <h5 class="tool-docs-h">Mode switches (top binary row)</h5>
      <dl class="tool-docs-dl">
        <dt>Media · Image | Video</dt>
        <dd>Only used when Detect is <strong>Force</strong>. Tells the op “treat this path
          as a still” or “as a video” even if the extension is weird. With Detect <strong>Auto</strong>
          (default), the file extension wins and this knob is ignored.</dd>
        <dt>Detect · Force | Auto</dt>
        <dd><strong>Auto</strong> (default): <code>.mp4</code>/<code>.mov</code>/… → video path;
          image extensions → still. <strong>Force</strong>: honor the Media knob instead.
          Use Force if a still is mis-detected or you opened a frames folder-like name.</dd>
        <dt>Jitter · Off | On</dt>
        <dd>Random pixel shift each ascent step (classic DeepDream trick).
          <strong>On</strong> (default) reduces tile seams and “grid” artifacts; slightly
          softer / more organic. Off can look sharper but more gridlocked.</dd>
        <dt>Detail · Off | On</dt>
        <dd><strong>Reinject detail between octaves.</strong> DeepDream works multi-scale
          (see Octaves). When On (default), high-frequency detail lost when scaling is
          mixed back in — richer texture. Off = smoother, more “smudged” dream.</dd>
        <dt>Audio · Drop | Keep</dt>
        <dd>Video only. <strong>Keep</strong> (default) muxes original audio onto the
          encoded result. Drop = silent video. Stills ignore this.</dd>
        <dt>Dry run · Run | Dry</dt>
        <dd><strong>Dry</strong> plans paths/params and returns without dreaming — use to
          check wiring. <strong>Run</strong> does the real job.</dd>
      </dl>

      <h5 class="tool-docs-h">Ascent knobs (how hard / how multi-scale)</h5>
      <p>
        Think of one “dream pass” as: for each <strong>octave</strong> (scale), take
        <strong>Iterations</strong> gradient steps of size <strong>Step</strong>, then
        move to a larger scale. Total work ≈ octaves × iterations × resolution.
      </p>
      <dl class="tool-docs-dl">
        <dt>Step (default 0.01)</dt>
        <dd>How far each ascent step moves in the “more activation” direction.
          Higher = faster, stronger, easier to blow out into noise.
          Lower = slower, subtler. Range ~0.001–0.1.
          The engine scales step per model (VGG/ResNet need a larger internal
          multiplier than Inception) so the same knob strength is roughly comparable.
          If results look like colorful static, cut Step first. If nothing changes,
          check <strong>Max loss is off</strong> and raise Step slightly.</dd>
        <dt>Iterations (default 20)</dt>
        <dd>Gradient steps <em>per octave</em>. More = denser patterns, longer runtime.
          Try 10 for previews, 20–40 for a solid still, higher only when you know Step
          is stable. Video multiplies this by frame count — keep modest on long clips.</dd>
        <dt>Octaves (default 3)</dt>
        <dd>How many resolution scales to climb. 1 = single scale (faster, flatter).
          3 is the classic multi-scale look (fine texture + large shapes).
          More octaves = more structure at more sizes, more time, more VRAM pressure.</dd>
        <dt>Oct scale (default 1.4)</dt>
        <dd>Size ratio between successive octaves (~1.1–2.0). Larger scale steps =
          bigger jump between “fine” and “coarse” levels. 1.4 is Google-ish.
          Closer to 1.1 = more gradual; closer to 2 = dramatic scale hops.</dd>
        <dt>Max loss (default <strong>off</strong>)</dt>
        <dd>Absolute ceiling on the ascent objective. When loss climbs past this,
          that octave stops early. <strong>Leave off (0) for VGG/ResNet</strong> —
          their losses are often hundreds of thousands; a ceiling of 15 stops after
          <em>one step</em> and the output looks like the original. Inception
          classic losses are smaller (often O(1–20)); a value like 15–25 can make
          sense there. Engine also auto-ignores max_loss if baseline loss already
          exceeds the threshold (wrong scale for the model).</dd>
        <dt>Blend (default 1.0)</dt>
        <dd>How much of the dreamed image to keep vs the original, at the end of the pass.
          <strong>1.0</strong> = full dream. <strong>0.5</strong> = half original, half dream
          (gentler “filter” look). <strong>0</strong> would be “no dream” (pointless).
          Useful when full dream is too aggressive for a photo you still want recognizable.</dd>
        <dt>Preview W (default full)</dt>
        <dd>If &gt; 0, dream at this max width (height scales). <strong>full</strong> = native
          resolution. Use 480–640 to iterate knobs quickly; set full for the final export.
          Does not change the “style” of layers, only how many pixels you pay for.</dd>
      </dl>

      <h5 class="tool-docs-h">Model</h5>
      <p>
        Which ImageNet CNN provides the features. Different nets → different “creatures”
        and textures. Weights may download once on first use.
      </p>
      <dl class="tool-docs-dl">
        <dt>InceptionV3 (default) — classic</dt>
        <dd>The Google DeepDream poster child. Mixed layers give that famous recursive
          dog-slug-architecture look. Best starting point for “looks like DeepDream.”</dd>
        <dt>VGG16 — hierarchical</dt>
        <dd>Older, very layered stack. Often cleaner edges / more “painterly” hierarchy.
          Shallow blocks = edges and textures; deep blocks = object-ish blobs and eyes.</dd>
        <dt>ResNet50 — residual</dt>
        <dd>Different residual features → different menagerie. Try when Inception feels
          samey or you want another aesthetic. Engine uses a higher internal step
          scale than Inception so UI Step feels similar; leave <strong>Max loss off</strong>
          (ResNet objectives are large — a low ceiling early-stops after one step).</dd>
      </dl>

      <h5 class="tool-docs-h">Layers (preset)</h5>
      <p>
        CNNs are a stack: early layers = edges, colors, small textures; late layers =
        larger shapes, object parts, whole-scene structure. Presets pick a weighted mix
        of real layers for the <em>current</em> model. “Deeper” = bigger, weirder forms;
        “shallower” = more filigree and surface.
      </p>
      <dl class="tool-docs-dl">
        <dt>Shallow</dt>
        <dd>Early layers only — fine textures, strokes, noise patterns. Subtle or
          psychedelic grit without huge floating dogs.</dd>
        <dt>Mid</dt>
        <dd>Middle of the net — balanced detail and structure.</dd>
        <dt>Deep</dt>
        <dd>Late layers — large forms, eyes, animals, architecture. Strong “hallucination.”</dd>
        <dt>Classic (default)</dt>
        <dd>Hand-tuned mid→deep mix in the spirit of public DeepDream demos.
          Good default for stills and video.</dd>
        <dt>Full</dt>
        <dd>Many layers at once — densest, busiest, often heaviest. Can overcook.</dd>
        <dt>Custom</dt>
        <dd>Shows per-layer weight knobs (0–5). <strong>0</strong> = that layer off.
          Higher weight = that layer pulls harder. Start from a preset’s idea, then
          zero what you hate and boost what you like. Only positive weights are sent.</dd>
      </dl>

      <h5 class="tool-docs-h">Video-only knobs</h5>
      <p>
        Visible when the input is treated as video and Ouroboros is off. Global
        <strong>frame range</strong> (bar above) still limits which portion of the clip
        is dumped. Dreaming every frame of a long HD clip can take a long time — use
        Max frames / Frame step / Preview W to scout.
      </p>
      <dl class="tool-docs-dl">
        <dt>Frame step (default 1)</dt>
        <dd><strong>1</strong> = dream every dumped frame. <strong>2</strong> = dream every
          other frame and hold the last dream on skipped frames (cheaper, slightly
          stepped motion). Higher = faster, choppier dream updates.</dd>
        <dt>Max frames (default all)</dt>
        <dd>Cap how many frames to process after dump/range. <strong>all</strong> = whole
          selection. Set 24–48 to test settings on a short slice before a full render.</dd>
        <dt>Temporal blend (default 0.85)</dt>
        <dd>Mixes the previous frame’s dream into the next start so the trip does not
          flicker randomly each frame. <strong>0.85</strong> is the classic “sticky”
          look. Lower = more independent per-frame dreams (flicker / strobe).
          <strong>off</strong> (≈1.0 on the knob format) = no temporal mix.
          Ignored when Optical flow is On (flow replaces this strategy).</dd>
        <dt>Optical flow · Off | On</dt>
        <dd>When On, estimates motion between frames and warps the dream residual so
          patterns stick to moving objects instead of swimming in place.
          Heavier and can glitch on hard cuts / pure noise; great on smooth camera moves.
          Overrides temporal blend while enabled.</dd>
        <dt>Layer cycle · Off | On</dt>
        <dd>When On, each frame optimizes <em>one</em> layer in a loop instead of the full
          weighted mix every frame (DeepDreamAnim-style). Creates a rhythmic morph of
          which “creature” dominates. Off (default) = same layer mix every frame
          (stable look). Fun for music-video energy; less for a single locked style.</dd>
      </dl>

      <h5 class="tool-docs-h">Ouroboros (still → feedback video)</h5>
      <p>
        Turns <strong>one still</strong> into a clip without a source video: dream the
        image, apply a small transform, use the result as the next input, repeat.
        Patterns crawl, zoom, and spin into infinity — the “endless zoom” DeepDream videos.
        Audio is not carried (there is no source soundtrack). Output is always a video.
      </p>
      <dl class="tool-docs-dl">
        <dt>Ouroboros · Off | On</dt>
        <dd>Master switch. On reveals transform + length knobs and hides the video-only
          bank (you are not processing a source clip).</dd>
        <dt>Transform</dt>
        <dd>
          Applied after each dreamed frame, before the next loop:
          <strong>Zoom + Spin</strong> (default) classic tunnel;
          <strong>Zoom only</strong> / <strong>Spin only</strong>;
          <strong>Translate</strong> pan by Pan X/Y;
          <strong>None</strong> pure feedback without geometric drift (patterns intensify in place).
        </dd>
        <dt>Frames (default 30)</dt>
        <dd>How many feedback steps / output frames. 30 @ 30 FPS ≈ 1 second. Longer =
          longer trip and much more total dream time (each frame is a full still dream).</dd>
        <dt>FPS (default 30)</dt>
        <dd>Playback rate of the written video. Transform amounts are scaled with FPS so
          “per second” motion stays similar if you change frame rate thoughtfully.</dd>
        <dt>Zoom (default 1.04)</dt>
        <dd>Scale factor per frame when zoom is in the transform. <strong>&gt; 1</strong> =
          zoom in (default mild crawl). <strong>&lt; 1</strong> = zoom out. Tiny changes
          compound over dozens of frames — 1.04 is already strong over 30–100 frames.</dd>
        <dt>Spin ° (default 1.5)</dt>
        <dd>Rotation degrees per frame. Positive / negative = direction. Small values
          accumulate into a full spin over the clip.</dd>
        <dt>Pan X / Pan Y (default 5)</dt>
        <dd>Pixel translation per frame when Translate (or a transform that uses them)
          is active. Positive X ≈ pan content left-ish (image shifts right depending on
          implementation convention); tweak by eye. Large pans + high Frames = content
          flies off-frame unless Zoom pulls new pixels from edges.</dd>
      </dl>

      <h5 class="tool-docs-h">Cost, cancel, and sanity</h5>
      <ul class="tool-docs-ul">
        <li><strong>Stills</strong> are the cheap playground. <strong>Video</strong> ≈ still cost × frame count (after range / max / step).</li>
        <li><strong>Ouroboros</strong> ≈ still cost × Frames — easy to underestimate.</li>
        <li>Use <strong>Preview W</strong>, <strong>Max frames</strong>, and low Iterations to scout; then full res.</li>
        <li><strong>Stop</strong> cancels between frames / during long jobs where the server checks cancel.</li>
        <li>If VRAM dies: lower Preview W, Octaves, or resolution of the source; close other GPU apps.</li>
        <li>Global frame range applies to video dreams (start/end on the bar above).</li>
      </ul>

      <h5 class="tool-docs-h">Evolve video</h5>
      <p>
        When <strong>Evolve</strong> is on, mid-ascent frames are saved, near-duplicates
        dropped with the same metrics as Image Sort (default pHash, min distance 4),
        optional RIFE fills gaps, then encodes <code>*_dream_evolve.mp4</code>.
        Frame 0 is the original; the final dream is always kept. Use this when ascent
        “spins its wheels” — progress climbs but the image barely changes.
        v1 is <strong>still images</strong> only (not video/ouro batches).
      </p>

      <h5 class="tool-docs-h">Recipe cheat-sheet</h5>
      <dl class="tool-docs-dl">
        <dt>Subtle texture pass</dt>
        <dd>Inception · Shallow · Iterations 10–15 · Blend 0.4–0.7 · Jitter On.</dd>
        <dt>Classic still</dt>
        <dd>Inception · Classic · defaults · full width.</dd>
        <dt>Heavy hallucination</dt>
        <dd>Deep or Full · Iterations 30–50 · slightly higher Step · watch Max loss.</dd>
        <dt>Guided “make it floral”</dt>
        <dd>Set Guide to a flower photo · Classic · mid Iterations · Blend ~0.8–1.</dd>
        <dt>Stable video trip</dt>
        <dd>Temporal blend ~0.85 · Optical flow Off first · Frame step 1 · short Max frames test.</dd>
        <dt>Flow-locked motion</dt>
        <dd>Optical flow On · smooth source (not hard cuts) · Classic layers.</dd>
        <dt>Ouroboros tunnel</dt>
        <dd>Ouroboros On · Zoom+Spin · Zoom 1.03–1.05 · Spin 1–2° · Frames 60–120 · Preview W while testing.</dd>
      </dl>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  // Continuous knobs
  setupContinuousKnob({
    knobId: 'dreamStepKnob', indicatorId: 'dreamStepKnobInd', valueId: 'dreamStepVal', hiddenId: 'dreamStep',
    min: 0.001, max: 0.1, step: 0.001, decimals: 3,
  });
  setupContinuousKnob({
    knobId: 'dreamItersKnob', indicatorId: 'dreamItersKnobInd', valueId: 'dreamItersVal', hiddenId: 'dreamIters',
    min: 1, max: 100, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOctavesKnob', indicatorId: 'dreamOctavesKnobInd', valueId: 'dreamOctavesVal', hiddenId: 'dreamOctaves',
    min: 1, max: 8, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOctScaleKnob', indicatorId: 'dreamOctScaleKnobInd', valueId: 'dreamOctScaleVal', hiddenId: 'dreamOctScale',
    min: 1.1, max: 2.0, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dreamMaxLossKnob', indicatorId: 'dreamMaxLossKnobInd', valueId: 'dreamMaxLossVal', hiddenId: 'dreamMaxLoss',
    // Absolute ceiling on ascent objective. 0 = off (recommended).
    // Inception often O(1–20); VGG can be O(1e5+) — low values early-stop after 1 step.
    min: 0, max: 50, step: 0.5, decimals: 1, format: (v) => (v <= 0 ? 'off' : v.toFixed(1)),
  });
  setupContinuousKnob({
    knobId: 'dreamBlendKnob', indicatorId: 'dreamBlendKnobInd', valueId: 'dreamBlendVal', hiddenId: 'dreamBlend',
    min: 0, max: 1, step: 0.05, decimals: 2,
  });
  setupContinuousKnob({
    knobId: 'dreamFrameStepKnob', indicatorId: 'dreamFrameStepKnobInd', valueId: 'dreamFrameStepVal', hiddenId: 'dreamFrameStep',
    min: 1, max: 30, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamMaxFramesKnob', indicatorId: 'dreamMaxFramesKnobInd', valueId: 'dreamMaxFramesVal', hiddenId: 'dreamMaxFrames',
    min: 0, max: 500, step: 1, decimals: 0, format: (v) => (v <= 0 ? 'all' : String(Math.round(v))),
  });
  setupContinuousKnob({
    knobId: 'dreamTemporalBlendKnob', indicatorId: 'dreamTemporalBlendKnobInd',
    valueId: 'dreamTemporalBlendVal', hiddenId: 'dreamTemporalBlend',
    min: 0, max: 1, step: 0.05, decimals: 2,
    format: (v) => (v >= 0.999 ? 'off' : v.toFixed(2)),
  });
  setupContinuousKnob({
    knobId: 'dreamPreviewWKnob', indicatorId: 'dreamPreviewWKnobInd',
    valueId: 'dreamPreviewWVal', hiddenId: 'dreamPreviewW',
    min: 0, max: 1280, step: 20, decimals: 0,
    format: (v) => (v <= 0 ? 'full' : String(Math.round(v))),
  });
  setupContinuousKnob({
    knobId: 'dreamOuroLenKnob', indicatorId: 'dreamOuroLenKnobInd', valueId: 'dreamOuroLenVal', hiddenId: 'dreamOuroLen',
    min: 1, max: 300, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamOuroFpsKnob', indicatorId: 'dreamOuroFpsKnobInd', valueId: 'dreamOuroFpsVal', hiddenId: 'dreamOuroFps',
    min: 1, max: 60, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamZoomKnob', indicatorId: 'dreamZoomKnobInd', valueId: 'dreamZoomVal', hiddenId: 'dreamZoom',
    min: 0.9, max: 1.15, step: 0.005, decimals: 3,
  });
  setupContinuousKnob({
    knobId: 'dreamSpinKnob', indicatorId: 'dreamSpinKnobInd', valueId: 'dreamSpinVal', hiddenId: 'dreamSpin',
    min: -15, max: 15, step: 0.1, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'dreamTxKnob', indicatorId: 'dreamTxKnobInd', valueId: 'dreamTxVal', hiddenId: 'dreamTx',
    min: -20, max: 20, step: 0.5, decimals: 1,
  });
  setupContinuousKnob({
    knobId: 'dreamTyKnob', indicatorId: 'dreamTyKnobInd', valueId: 'dreamTyVal', hiddenId: 'dreamTy',
    min: -20, max: 20, step: 0.5, decimals: 1,
  });

  // Binary knobs
  // Media: store image|video; Detect: 0=force 1=auto
  setupBinaryKnob({
    knobId: 'dreamMediaKnob', indicatorId: 'dreamMediaKnobInd', hiddenId: 'dreamMedia',
    leftValue: 'image', rightValue: 'video', leftLabel: 'Image', rightLabel: 'Video',
    initial: 'image',
  });
  setupBinaryKnob({
    knobId: 'dreamAutoDetectKnob', indicatorId: 'dreamAutoDetectKnobInd', hiddenId: 'dreamAutoDetect',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamJitterKnob', indicatorId: 'dreamJitterKnobInd', hiddenId: 'dreamJitter',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamDetailKnob', indicatorId: 'dreamDetailKnobInd', hiddenId: 'dreamDetail',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamAudioKnob', indicatorId: 'dreamAudioKnobInd', hiddenId: 'dreamAudio',
    leftValue: '0', rightValue: '1', initial: '1',
  });
  setupBinaryKnob({
    knobId: 'dreamDryRunKnob', indicatorId: 'dreamDryRunKnobInd', hiddenId: 'dreamDryRun',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamOuroKnob', indicatorId: 'dreamOuroKnobInd', hiddenId: 'dreamOuro',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamOpticalFlowKnob', indicatorId: 'dreamOpticalFlowKnobInd', hiddenId: 'dreamOpticalFlow',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupBinaryKnob({
    knobId: 'dreamLayerCycleKnob', indicatorId: 'dreamLayerCycleKnobInd', hiddenId: 'dreamLayerCycle',
    leftValue: '0', rightValue: '1', initial: '0',
  });
  setupEvolveMasterToggle('dreamEvolve', '.dream-evolve-only');
  setupEvolveRifeKnobs('dreamEvolve');
  setupContinuousKnob({
    knobId: 'dreamEvolveFpsKnob', indicatorId: 'dreamEvolveFpsKnobInd',
    valueId: 'dreamEvolveFpsVal', hiddenId: 'dreamEvolveFps',
    min: 1, max: 60, step: 1, decimals: 0,
  });
  setupContinuousKnob({
    knobId: 'dreamEvolveThrKnob', indicatorId: 'dreamEvolveThrKnobInd',
    valueId: 'dreamEvolveThrVal', hiddenId: 'dreamEvolveThr',
    min: 0, max: 32, step: 0.5, decimals: 1,
    format: (v) => (v <= 0 ? 'all' : v.toFixed(1)),
  });
  setupContinuousKnob({
    knobId: 'dreamEvolveCapNKnob', indicatorId: 'dreamEvolveCapNKnobInd',
    valueId: 'dreamEvolveCapNVal', hiddenId: 'dreamEvolveCapN',
    min: 0, max: 20, step: 1, decimals: 0,
    format: (v) => (v <= 0 ? 'auto' : String(Math.round(v))),
  });

  function rebuildLayerUiForModel(modelKey, { keepPreset = true } = {}) {
    const spec = DREAM_MODELS[modelKey] || DREAM_MODELS.inception_v3;
    const presetSel = document.getElementById('dreamLayerPreset');
    const prevPreset = keepPreset ? (presetSel?.value || 'classic') : 'classic';
    if (presetSel) {
      presetSel.innerHTML = Object.entries(spec.presets)
        .map(([k, label]) => `<option value="${k}">${label}</option>`)
        .join('');
      if (spec.presets[prevPreset]) presetSel.value = prevPreset;
      else presetSel.value = 'classic';
    }
    const bank = document.getElementById('dreamLayerWeightsBank');
    if (bank) {
      bank.innerHTML = spec.layers.map((L) => {
        const safeId = `dreamL_${L.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        return knobUnitHtml({ id: safeId, label: L.label, value: String(L.def) });
      }).join('');
      spec.layers.forEach((L) => {
        const safeId = `dreamL_${L.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        setupContinuousKnob({
          knobId: `${safeId}Knob`,
          indicatorId: `${safeId}KnobInd`,
          valueId: `${safeId}Val`,
          hiddenId: safeId,
          min: 0, max: 5, step: 0.1, decimals: 1,
        });
        // store real layer name for collect
        const hid = document.getElementById(safeId);
        if (hid) hid.dataset.layerName = L.id;
      });
    }
  }

  function syncDreamUiVisibility() {
    const preset = document.getElementById('dreamLayerPreset')?.value;
    const custom = preset === 'custom';
    document.querySelectorAll('.dream-layer-weights').forEach((el) => {
      el.classList.toggle('hidden', !custom);
    });

    const ouro = document.getElementById('dreamOuro')?.value === '1';
    document.querySelectorAll('.dream-ouro-only').forEach((el) => {
      el.classList.toggle('hidden', !ouro);
    });

    // evolve panel: setupEvolveMasterToggle keeps .dream-evolve-only in sync

    const auto = document.getElementById('dreamAutoDetect')?.value === '1';
    const media = document.getElementById('dreamMedia')?.value || 'image';
    const input = document.getElementById('dreamInput')?.value || '';
    let showVideo = false;
    if (!ouro) {
      if (auto) {
        showVideo = /\.(mp4|m4v|mov|mkv|webm|avi|mpg|mpeg)$/i.test(input);
      } else {
        showVideo = media === 'video';
      }
    }
    document.querySelectorAll('.dream-video-only').forEach((el) => {
      el.classList.toggle('hidden', !showVideo);
    });
  }

  rebuildLayerUiForModel(document.getElementById('dreamModel')?.value || 'inception_v3');

  document.getElementById('dreamModel')?.addEventListener('change', (e) => {
    rebuildLayerUiForModel(e.target.value);
    syncDreamUiVisibility();
    logConsole(`[DEEPDREAM]: Model → ${e.target.value}`);
  });
  document.getElementById('dreamLayerPreset')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamAutoDetect')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamMedia')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamOuro')?.addEventListener('change', syncDreamUiVisibility);
  document.getElementById('dreamInput')?.addEventListener('input', syncDreamUiVisibility);

  document.getElementById('btnDreamBrowseIn')?.addEventListener('click', () => {
    // Prefer all files so both images and videos are visible
    openFileBrowser('dreamInput', false, 'file', 'all');
  });
  document.getElementById('btnDreamBrowseOut')?.addEventListener('click', () => {
    openFileBrowser('dreamOutput', false, 'file_save', 'all');
  });
  document.getElementById('btnDreamBrowseGuide')?.addEventListener('click', () => {
    openFileBrowser('dreamGuide', false, 'file', 'image');
  });

  // Apply pending send-to path
  if (state.pendingInputPath && state.pendingInputTarget === 'deepdream') {
    const inp = document.getElementById('dreamInput');
    if (inp) {
      inp.value = state.pendingInputPath;
      inp.dispatchEvent(new Event('input'));
    }
    state.pendingInputPath = null;
    state.pendingInputTarget = null;
  }

  syncDreamUiVisibility();
}

function collectDeepDreamBody() {
  const input = bestInput('dreamInput');
  const output = document.getElementById('dreamOutput')?.value?.trim() || null;
  if (!input) {
    alert('Please provide an input image or video path.');
    return null;
  }

  const auto = document.getElementById('dreamAutoDetect')?.value === '1';
  const mediaKnob = document.getElementById('dreamMedia')?.value || 'image';
  let media_kind = 'auto';
  if (!auto) media_kind = mediaKnob === 'video' ? 'video' : 'image';

  const maxFramesRaw = parseFloat(document.getElementById('dreamMaxFrames')?.value || '0');
  const max_frames = maxFramesRaw > 0 ? Math.round(maxFramesRaw) : null;
  const ouroboros = document.getElementById('dreamOuro')?.value === '1';
  const guide = document.getElementById('dreamGuide')?.value?.trim() || null;
  const previewW = parseInt(document.getElementById('dreamPreviewW')?.value || '0', 10);
  const model_name = document.getElementById('dreamModel')?.value || 'inception_v3';
  const layer_preset = document.getElementById('dreamLayerPreset')?.value || 'classic';

  // Collect custom layer knobs (real names in data-layer-name)
  const custom_layer_weights = {};
  document.querySelectorAll('#dreamLayerWeightsBank input[type="hidden"][data-layer-name]').forEach((el) => {
    const name = el.dataset.layerName;
    const w = parseFloat(el.value);
    if (name && Number.isFinite(w) && w > 0) custom_layer_weights[name] = w;
  });

  return withFrameRange({
    input_path: input,
    output_path: output,
    media_kind,
    model_name,
    step: parseFloat(document.getElementById('dreamStep')?.value || '0.01'),
    iterations: parseInt(document.getElementById('dreamIters')?.value || '20', 10),
    num_octave: parseInt(document.getElementById('dreamOctaves')?.value || '3', 10),
    octave_scale: parseFloat(document.getElementById('dreamOctScale')?.value || '1.4'),
    max_loss: parseFloat(document.getElementById('dreamMaxLoss')?.value || '0'),
    blend: parseFloat(document.getElementById('dreamBlend')?.value || '1'),
    jitter: document.getElementById('dreamJitter')?.value === '1',
    reinject_detail: document.getElementById('dreamDetail')?.value === '1',
    keep_audio: document.getElementById('dreamAudio')?.value === '1',
    layer_preset,
    custom_layer_weights: layer_preset === 'custom' ? custom_layer_weights : null,
    frame_step: parseInt(document.getElementById('dreamFrameStep')?.value || '1', 10),
    max_frames,
    temporal_blend: parseFloat(document.getElementById('dreamTemporalBlend')?.value || '0.85'),
    optical_flow: document.getElementById('dreamOpticalFlow')?.value === '1',
    layer_cycle: document.getElementById('dreamLayerCycle')?.value === '1',
    guide_path: guide,
    preview_width: previewW > 0 ? previewW : 0,
    ouroboros,
    ouroboros_length: parseInt(document.getElementById('dreamOuroLen')?.value || '30', 10),
    ouroboros_fps: parseFloat(document.getElementById('dreamOuroFps')?.value || '30'),
    frame_transform: document.getElementById('dreamFrameTransform')?.value || 'zoom_rotate',
    zoom: parseFloat(document.getElementById('dreamZoom')?.value || '1.04'),
    rotation_deg: parseFloat(document.getElementById('dreamSpin')?.value || '1.5'),
    translate_x: parseFloat(document.getElementById('dreamTx')?.value || '5'),
    translate_y: parseFloat(document.getElementById('dreamTy')?.value || '5'),
    dry_run: document.getElementById('dreamDryRun')?.value === '1',
    evolve_enabled: document.getElementById('dreamEvolve')?.value === '1',
    evolve_fps: parseFloat(document.getElementById('dreamEvolveFps')?.value || '12'),
    evolve_metric: document.getElementById('dreamEvolveMetric')?.value || 'phash',
    evolve_threshold: parseFloat(document.getElementById('dreamEvolveThr')?.value || '4'),
    evolve_capture_every: parseInt(document.getElementById('dreamEvolveCapN')?.value || '0', 10),
    evolve_max_candidates: 500,
    ...collectEvolveRifeFields('dreamEvolve'),
  });
}

export { DREAM_MODELS, renderDeepDreamForm, collectDeepDreamBody };
