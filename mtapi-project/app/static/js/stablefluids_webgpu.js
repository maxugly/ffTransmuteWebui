/**
 * Pure WebGPU port of keijiro/StableFluids (Jos Stam's "Stable Fluids").
 * Phases 2 + 3 of docs/stablefluids-sim-spec.md.
 *
 * No Unity wasm, standalone ES6 module. Per spec §6.2 the sim is three
 * compute passes (Advection, Divergence / pressure Jacobi, pressure gradient
 * subtract) plus a small spray pass for the mouse injection and a fullscreen
 * present pass.
 *
 * Storage-texture rule honored: read_write storage is only supported for
 * r32float/sint/uint, so every pass reads sources VIA SAMPLING (texture_2d<f32>
 * bindings) and writes via textureStore only. A texture is never bound as both
 * sampled and storage in the same pass.
 *
 * Pass fidelity (from keijiro's FluidSimulation.shader):
 *   Spray    straight copy of vel/dye with an optional gaussian window
 *            injection (pointer velocity + hue paint) when active
 *   Advect   uv' = uv - vel·dt, vel.y ·= W/H           (bilinear, clamp edges)
 *   PSetup   div = ((vR.x-vL.x) + (vU.y-vD.y)) · W · 0.5
 *   Jacobi   x = (Σneighbors + α·b)/β,  α = -dx², β = 4, 20 iterations
 *   PFinish  u = w - (pR-pL, pU-pD)·W·0.5; left/right ⇒ u.x = -u.x,
 *            top/bottom ⇒ u.y = -u.y
 * The Unity build's viscosity diffusion (vector Jacobi pass) is the identity
 * for its default viscosity and is omitted from the spec's three-pass port.
 * Dye dissipation is 1.0 (persists) so an injected seed image stays on screen
 * until it is stirred by the velocity field instead of fading to black.
 */
const SIZE = 512;
const DT = 0.016;
const VEL_DISSIPATION = 0.985;
const DYE_DISSIPATION = 1.0;      // 1.0 = seed/injected dye persists until smeared
const PRESSURE_ITERS = 20;
const SPRAY_K = 7;              // odd spray window width (cells)
const SPRAY_SIGMA = 1.4;        // gaussian sigma of the window (cells)
const VEL_GAIN = 0.15;          // pointer speed → velocity field strength
const DYE_GAIN = 0.08;          // paint amount per frame while injecting

const PRESENT_FRAG = /* wgsl */ `
  @group(0) @binding(0) var dye: texture_2d<f32>;
  @group(0) @binding(1) var samp: sampler;
  struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> }
  @vertex fn vs(@builtin(vertex_index) vid: u32) -> VsOut {
    var pos = vec2<f32>(0.0);
    if (vid == 0u) { pos = vec2<f32>(-1.0, -1.0); }
    else if (vid == 1u) { pos = vec2<f32>(3.0, -1.0); }
    else { pos = vec2<f32>(-1.0, 3.0); }
    return VsOut(vec4<f32>(pos, 0.0, 1.0), pos * 0.5 + 0.5);
  }
  @fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
    let c = textureSampleLevel(dye, samp, in.uv, 0.0);
    return vec4<f32>(c.rgb, 1.0);
  }
`;

const SPRAY = /* wgsl */ `
  const K = ${SPRAY_K}u;
  struct Spray { origin: vec2<f32>, flag: u32, _pad: u32 }
  @group(0) @binding(0) var<uniform> u: Spray;
  @group(0) @binding(1) var velSrc: texture_2d<f32>;
  @group(0) @binding(2) var velDst: texture_storage_2d<rgba16float, write>;
  @group(0) @binding(3) var dyeSrc: texture_2d<f32>;
  @group(0) @binding(4) var dyeDst: texture_storage_2d<rgba8unorm, write>;
  @group(0) @binding(5) var velSpray: texture_2d<f32>;
  @group(0) @binding(6) var dyeSpray: texture_2d<f32>;
  @group(0) @binding(7) var samp: sampler;
  @compute @workgroup_size(8, 8, 1)
  fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let puv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(${SIZE}.0, ${SIZE}.0);
    let v = textureSampleLevel(velSrc, samp, puv, 0.0);
    let d = textureSampleLevel(dyeSrc, samp, puv, 0.0);
    if (u.flag == 1u) {
      let k = vec2<i32>(gid.xy) - vec2<i32>(u.origin);
      if (k.x >= 0 && k.y >= 0 && k.x < i32(K) && k.y < i32(K)) {
        let kuv = (vec2<f32>(k) + 0.5) / vec2<f32>(f32(K), f32(K));
        let vk = textureSampleLevel(velSpray, samp, kuv, 0.0).xy;
        var vv = v;
        if (vk.x != 0.0 || vk.y != 0.0) { vv = vec4<f32>(v.xy + vk, 0.0, 1.0); }
        textureStore(velDst, gid.xy, vv);
        let dk = textureSampleLevel(dyeSpray, samp, kuv, 0.0);
        textureStore(dyeDst, gid.xy, clamp(d + dk, vec4<f32>(0.0), vec4<f32>(1.0)));
        return;
      }
    }
    textureStore(velDst, gid.xy, v);
    textureStore(dyeDst, gid.xy, d);
  }
`;

const ADVECT = /* wgsl */ `
  const SIZE = ${SIZE}.0;
  const DT = ${DT};
  const VEL_DISSIPATION = ${VEL_DISSIPATION};
  const DYE_DISSIPATION = ${DYE_DISSIPATION};
  @group(0) @binding(0) var velSrc: texture_2d<f32>;
  @group(0) @binding(1) var velDst: texture_storage_2d<rgba16float, write>;
  @group(0) @binding(2) var dyeSrc: texture_2d<f32>;
  @group(0) @binding(3) var dyeDst: texture_storage_2d<rgba8unorm, write>;
  @group(0) @binding(4) var samp: sampler;
  @compute @workgroup_size(8, 8, 1)
  fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let coord = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(SIZE, SIZE);
    var vel = textureSampleLevel(velSrc, samp, coord, 0.0).xy;
    vel.y *= SIZE / SIZE;
    let uvPrev = coord - vel * DT;
    let nv = textureSampleLevel(velSrc, samp, uvPrev, 0.0).xy * VEL_DISSIPATION;
    textureStore(velDst, gid.xy, vec4<f32>(nv, 0.0, 1.0));
    let nd = textureSampleLevel(dyeSrc, samp, uvPrev, 0.0) * DYE_DISSIPATION;
    textureStore(dyeDst, gid.xy, nd);
  }
`;

const PSETUP = /* wgsl */ `
  const SIZE = ${SIZE}.0;
  @group(0) @binding(0) var velSrc: texture_2d<f32>;
  @group(0) @binding(1) var divDst: texture_storage_2d<r32float, write>;
  @group(0) @binding(2) var samp: sampler;
  fn clampUv(uv: vec2<f32>) -> vec2<f32> {
    let lo = 1.5 / SIZE;
    let hi = (SIZE - 1.5) / SIZE;
    return clamp(uv, vec2<f32>(lo), vec2<f32>(hi));
  }
  @compute @workgroup_size(8, 8, 1)
  fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(SIZE, SIZE);
    let s = 1.0 / SIZE;
    let vL = textureSampleLevel(velSrc, samp, clampUv(uv - vec2<f32>(s, 0.0)), 0.0).xy;
    let vR = textureSampleLevel(velSrc, samp, clampUv(uv + vec2<f32>(s, 0.0)), 0.0).xy;
    let vD = textureSampleLevel(velSrc, samp, clampUv(uv - vec2<f32>(0.0, s)), 0.0).xy;
    let vU = textureSampleLevel(velSrc, samp, clampUv(uv + vec2<f32>(0.0, s)), 0.0).xy;
    var div = ((vR.x - vL.x) + (vU.y - vD.y)) * SIZE * 0.5;
    div = clamp(div, -16.0, 16.0);
    textureStore(divDst, gid.xy, vec4<f32>(div, 0.0, 0.0, 1.0));
  }
`;

const PRESSURE = /* wgsl */ `
  const SIZE = ${SIZE}.0;
  const ALPHA = -1.0 / (SIZE * SIZE);
  const BETA = 4.0;
  @group(0) @binding(0) var presSrc: texture_2d<f32>;
  @group(0) @binding(1) var presDst: texture_storage_2d<r32float, write>;
  @group(0) @binding(2) var divSrc: texture_2d<f32>;
  @group(0) @binding(3) var samp: sampler;
  fn clampUv(uv: vec2<f32>) -> vec2<f32> {
    let lo = 1.5 / SIZE;
    let hi = (SIZE - 1.5) / SIZE;
    return clamp(uv, vec2<f32>(lo), vec2<f32>(hi));
  }
  @compute @workgroup_size(8, 8, 1)
  fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(SIZE, SIZE);
    let s = 1.0 / SIZE;
    let xl = textureSampleLevel(presSrc, samp, clampUv(uv - vec2<f32>(s, 0.0)), 0.0).x;
    let xr = textureSampleLevel(presSrc, samp, clampUv(uv + vec2<f32>(s, 0.0)), 0.0).x;
    let xd = textureSampleLevel(presSrc, samp, clampUv(uv - vec2<f32>(0.0, s)), 0.0).x;
    let xu = textureSampleLevel(presSrc, samp, clampUv(uv + vec2<f32>(0.0, s)), 0.0).x;
    let b = textureSampleLevel(divSrc, samp, uv, 0.0).x;
    let x = (xl + xr + xd + xu + ALPHA * b) / BETA;
    textureStore(presDst, gid.xy, vec4<f32>(x, 0.0, 0.0, 1.0));
  }
`;

const PFINISH = /* wgsl */ `
  const SIZE = ${SIZE}.0;
  @group(0) @binding(0) var velSrc: texture_2d<f32>;
  @group(0) @binding(1) var presSrc: texture_2d<f32>;
  @group(0) @binding(2) var velDst: texture_storage_2d<rgba16float, write>;
  @group(0) @binding(3) var sampLinear: sampler;
  @group(0) @binding(4) var sampNearest: sampler;
  fn clampUv(uv: vec2<f32>) -> vec2<f32> {
    let lo = 1.5 / SIZE;
    let hi = (SIZE - 1.5) / SIZE;
    return clamp(uv, vec2<f32>(lo), vec2<f32>(hi));
  }
  @compute @workgroup_size(8, 8, 1)
  fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(SIZE, SIZE);
    let s = 1.0 / SIZE;
    let pl = textureSampleLevel(presSrc, sampNearest, clampUv(uv - vec2<f32>(s, 0.0)), 0.0).x;
    let pr = textureSampleLevel(presSrc, sampNearest, clampUv(uv + vec2<f32>(s, 0.0)), 0.0).x;
    let pd = textureSampleLevel(presSrc, sampNearest, clampUv(uv - vec2<f32>(0.0, s)), 0.0).x;
    let pu = textureSampleLevel(presSrc, sampNearest, clampUv(uv + vec2<f32>(0.0, s)), 0.0).x;
    let w = textureSampleLevel(velSrc, sampLinear, uv, 0.0).xy;
    var u = w - vec2<f32>(pr - pl, pu - pd) * SIZE * 0.5;
    if (gid.x == 0u || gid.x == ${SIZE}u - 1u) { u.x = -u.x; }
    if (gid.y == 0u || gid.y == ${SIZE}u - 1u) { u.y = -u.y; }
    textureStore(velDst, gid.xy, vec4<f32>(u, 0.0, 1.0));
  }
`;

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

/**
 * Create the native (WebGPU) fluid sim on a canvas.
 *
 * @param {Object} opts
 * @param {HTMLCanvasElement} opts.canvas
 * @param {string} [opts.seedUrl] http(s) still URL used as the starting dye
 *   field (Phase 3 image injection). Uploaded before the first animate().
 *   Empty → black field.
 * @param {(msg: string) => void} [opts.onError]
 * @returns {Promise<{ok: true, stop: () => void}|{ok: false, error: string}>}
 */
export async function createStableFluidsSim({ canvas, seedUrl, onError }) {
  if (!navigator.gpu) return { ok: false, error: 'WebGPU not supported' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, error: 'No WebGPU adapter' };
    const device = await adapter.requestDevice();

    const size = SIZE;
    const context = canvas.getContext('webgpu');
    if (!context) return { ok: false, error: 'No WebGPU context' };
    canvas.width = size;
    canvas.height = size;
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });

    device.lost.then(ev => { if (onError) onError('WebGPU device lost: ' + ev.message); });

    const ss = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    const ssCopyDst = ss | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT;
    const mkTex = (label, w, h, fmtT, usage) =>
      device.createTexture({ label, size: { width: w, height: h }, format: fmtT, usage, mipLevelCount: 1 });

    // live velocity = velA (output of finished projection). velB = spray out; velC = advect out.
    const velA = mkTex('sf-velA', size, size, 'rgba16float', ss);
    const velB = mkTex('sf-velB', size, size, 'rgba16float', ss);
    const velC = mkTex('sf-velC', size, size, 'rgba16float', ss);
    // live dye = dyeA (what the present pass shows). spray goes to dyeB, advect pulls back to dyeA.
    const dyeA = mkTex('sf-dyeA', size, size, 'rgba8unorm', ssCopyDst);
    const dyeB = mkTex('sf-dyeB', size, size, 'rgba8unorm', ssCopyDst);
    const presA = mkTex('sf-presA', size, size, 'r32float', ss);
    const presB = mkTex('sf-presB', size, size, 'r32float', ss);
    const div = mkTex('sf-div', size, size, 'r32float', ss);
    const sprayVel = mkTex('sf-sprayVel', SPRAY_K, SPRAY_K, 'rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
    const sprayDye = mkTex('sf-sprayDye', SPRAY_K, SPRAY_K, 'rgba16float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);

    const linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    const module = (label, code) => {
      const m = device.createShaderModule({ label, code });
      m.getCompilationInfo().then(ci => {
        const err = ci.messages.find(x => x.type === 'error' || x.type === 'error-filterable');
        if (err && onError) onError(`${label}: ${err.message} (line ${err.lineNum})`);
      }).catch(() => {});
      return m;
    };

    const COMPUTE = GPUShaderStage.COMPUTE;
    const VERTEX = GPUShaderStage.VERTEX;
    const FRAGMENT = GPUShaderStage.FRAGMENT;
    const bgl = (bindings) => device.createBindGroupLayout({ entries: bindings });
    const bgFrom = (layout, entries) => device.createBindGroup({ layout, entries });
    const bindTex = (binding, view) => ({ binding, resource: view });
    const bindBuf = (binding, buffer) => ({ binding, resource: { buffer } });
    const bindSmp = (binding, s) => ({ binding, resource: s });

    const row = (binding, type = 'uniform') => ({ binding, visibility: COMPUTE, buffer: { type } });
    const ttex = (binding, fmt = 'float') => ({ binding, visibility: COMPUTE, texture: { sampleType: fmt } });
    const stex = (binding, fmtT, access = 'write-only') =>
      ({ binding, visibility: COMPUTE, storageTexture: { format: fmtT, access, viewDimension: '2d' } });
    const smp = (binding, filter = 'filtering') => ({ binding, visibility: COMPUTE, sampler: { type: filter } });

    // ---- present ----
    const presentShader = module('sf-present', PRESENT_FRAG);
    const presentLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl([
      { binding: 0, visibility: FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: FRAGMENT, sampler: { type: 'filtering' } },
    ])] });
    const presentPipeline = device.createRenderPipeline({
      layout: presentLayout,
      vertex: { module: presentShader, entryPoint: 'vs' },
      primitive: { topology: 'triangle-list' },
      fragment: { module: presentShader, entryPoint: 'fs', targets: [{ format }] },
    });
    const presentBG = bgFrom(presentPipeline.getBindGroupLayout(0), [
      bindTex(0, dyeA.createView()),
      bindSmp(1, linear),
    ]);

    // ---- spray ----
    const sprayShader = module('sf-spray', SPRAY);
    const sprayLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl([
      row(0), ttex(1), stex(2, 'rgba16float'), ttex(3), stex(4, 'rgba8unorm'), ttex(5), ttex(6), smp(7),
    ])] });
    const sprayPipeline = device.createComputePipeline({
      layout: sprayLayout, compute: { module: sprayShader, entryPoint: 'main' },
    });
    const sprayUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sprayBG = bgFrom(sprayPipeline.getBindGroupLayout(0), [
      bindBuf(0, sprayUniform),
      bindTex(1, velA.createView()),
      bindTex(2, velB.createView()),
      bindTex(3, dyeA.createView()),
      bindTex(4, dyeB.createView()),
      bindTex(5, sprayVel.createView()),
      bindTex(6, sprayDye.createView()),
      bindSmp(7, linear),
    ]);

    // ---- advect ----
    const advectShader = module('sf-advect', ADVECT);
    const advectLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl([
      ttex(0), stex(1, 'rgba16float'), ttex(2), stex(3, 'rgba8unorm'), smp(4),
    ])] });
    const advectPipeline = device.createComputePipeline({
      layout: advectLayout, compute: { module: advectShader, entryPoint: 'main' },
    });
    const advectBG = bgFrom(advectPipeline.getBindGroupLayout(0), [
      bindTex(0, velB.createView()),
      bindTex(1, velC.createView()),
      bindTex(2, dyeB.createView()),
      bindTex(3, dyeA.createView()),
      bindSmp(4, linear),
    ]);

    // ---- projection setup (divergence) ----
    const psetupShader = module('sf-psetup', PSETUP);
    const psetupLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl([
      ttex(0), stex(1, 'r32float'), smp(2),
    ])] });
    const psetupPipeline = device.createComputePipeline({
      layout: psetupLayout, compute: { module: psetupShader, entryPoint: 'main' },
    });
    const psetupBG = bgFrom(psetupPipeline.getBindGroupLayout(0), [
      bindTex(0, velC.createView()),
      bindTex(1, div.createView()),
      bindSmp(2, linear),
    ]);

    // ---- pressure (Jacobi, ping-pong) ----
    const pressureShader = module('sf-pressure', PRESSURE);
    const pressureLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl([
      ttex(0, 'unfilterable-float'), stex(1, 'r32float'), ttex(2, 'unfilterable-float'), smp(3, 'non-filtering'),
    ])] });
    const pressurePipeline = device.createComputePipeline({
      layout: pressureLayout, compute: { module: pressureShader, entryPoint: 'main' },
    });
    const pl = pressurePipeline.getBindGroupLayout(0);
    const pressureBG0 = bgFrom(pl, [bindTex(0, presA.createView()), bindTex(1, presB.createView()), bindTex(2, div.createView()), bindSmp(3, nearest)]);
    const pressureBG1 = bgFrom(pl, [bindTex(0, presB.createView()), bindTex(1, presA.createView()), bindTex(2, div.createView()), bindSmp(3, nearest)]);

    // ---- projection finish (gradient subtract) ----
    const pfinishShader = module('sf-pfinish', PFINISH);
    const pfinishLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl([
      ttex(0), ttex(1, 'unfilterable-float'), stex(2, 'rgba16float'), smp(3), smp(4, 'non-filtering'),
    ])] });
    const pfinishPipeline = device.createComputePipeline({
      layout: pfinishLayout, compute: { module: pfinishShader, entryPoint: 'main' },
    });
    const fl = pfinishPipeline.getBindGroupLayout(0);
    const linear2 = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const pfinishBG0 = bgFrom(fl, [bindTex(0, velC.createView()), bindTex(1, presA.createView()), bindTex(2, velA.createView()), bindSmp(3, linear2), bindSmp(4, nearest)]);
    const pfinishBG1 = bgFrom(fl, [bindTex(0, velC.createView()), bindTex(1, presB.createView()), bindTex(2, velA.createView()), bindSmp(3, linear2), bindSmp(4, nearest)]);

    // ---- seed injection (Phase 3): initial dye = user still ----
    if (seedUrl) {
      try {
        const resp = await fetch(seedUrl);
        if (resp.ok) {
          const bmp = await createImageBitmap(await resp.blob());
          device.queue.copyExternalImageToTexture(
            { source: bmp, flipY: false },
            { texture: dyeA },
            { width: size, height: size },
          );
        } else if (onError) onError(`Seed fetch failed (${resp.status})`);
      } catch (e) {
        if (onError) onError('Seed image error: ' + (e && e.message || e));
      }
    }

    // ---- mouse injection ----
    const pointer = { down: false, pos: { x: size / 2, y: size / 2 }, last: { x: size / 2, y: size / 2 } };
    const toCell = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * size;
      const y = (e.clientY - r.top) / r.height * size;
      return { x: Math.max(1, Math.min(size - 2, x)), y: Math.max(1, Math.min(size - 2, y)) };
    };
    const onDown = (e) => { pointer.down = true; pointer.pos = toCell(e); pointer.last = { ...pointer.pos }; if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } } };
    const onMove = (e) => { if (pointer.down) pointer.pos = toCell(e); };
    const onUp = (e) => { pointer.down = false; };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // ---- spray buffer building ----
    const velSprayData = new Float32Array(SPRAY_K * SPRAY_K * 4); // rgba16float = 4 f32 / texel
    const dyeSprayData = new Float32Array(SPRAY_K * SPRAY_K * 4);
    const uniformBuf = new ArrayBuffer(16);
    const uniformF32 = new Float32Array(uniformBuf);
    const uniformU32 = new Uint32Array(uniformBuf);
    const cx = (SPRAY_K >> 1);
    const cy = (SPRAY_K >> 1);
    let paintHue = 0;

    function buildSpray(now) {
      const wts = 1 / (2 * SPRAY_SIGMA * SPRAY_SIGMA);
      const dx = pointer.pos.x - pointer.last.x;
      const dy = pointer.pos.y - pointer.last.y;
      pointer.last.x = pointer.pos.x;
      pointer.last.y = pointer.pos.y;
      paintHue = (paintHue + 0.002) % 1;
      const rgb = hsvToRgb(paintHue, 0.85, 1.0);
      const active = pointer.down ? 1 : 0;
      if (active) {
        for (let j = 0; j < SPRAY_K; j++) {
          for (let i = 0; i < SPRAY_K; i++) {
            const kdx = i - cx, kdy = j - cx;
            const w = Math.exp(-(kdx * kdx + kdy * kdy) * wts);
            const o = (j * SPRAY_K + i) * 4;
            const velScale = (1 / size) * (1 / DT) * VEL_GAIN;
            velSprayData[o] = dx * velScale * w;
            velSprayData[o + 1] = dy * velScale * w;
            velSprayData[o + 2] = 0;
            velSprayData[o + 3] = 1;
            dyeSprayData[o] = rgb[0] * DYE_GAIN * w;
            dyeSprayData[o + 1] = rgb[1] * DYE_GAIN * w;
            dyeSprayData[o + 2] = rgb[2] * DYE_GAIN * w;
            dyeSprayData[o + 3] = 1;
          }
        }
      } else {
        velSprayData.fill(0);
        dyeSprayData.fill(0);
      }
      uniformF32[0] = Math.round(pointer.pos.x) - cx;
      uniformF32[1] = Math.round(pointer.pos.y) - cy;
      uniformU32[2] = active;
      uniformU32[3] = 0;
      device.queue.writeTexture({ texture: sprayVel }, velSprayData, { bytesPerRow: SPRAY_K * 8, rowsPerImage: SPRAY_K }, { width: SPRAY_K, height: SPRAY_K });
      device.queue.writeTexture({ texture: sprayDye }, dyeSprayData, { bytesPerRow: SPRAY_K * 8, rowsPerImage: SPRAY_K }, { width: SPRAY_K, height: SPRAY_K });
      device.queue.writeBuffer(sprayUniform, 0, uniformBuf);
    }

    let raf = 0;
    let stopFlag = false;
    let frames = 0;

    const step = () => {
      if (stopFlag) return;
      raf = requestAnimationFrame(step);
      const now = performance.now();
      buildSpray(now);
      const enc = device.createCommandEncoder();
      const dispatch = (pipeline, bg) => {
        const pass = enc.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bg);
        pass.dispatchWorkgroups(Math.ceil(size / 8), Math.ceil(size / 8));
        pass.end();
      };
      dispatch(sprayPipeline, sprayBG);
      dispatch(advectPipeline, advectBG);
      dispatch(psetupPipeline, psetupBG);
      let cur = presA, out = presB, bg0 = false;
      for (let i = 0; i < PRESSURE_ITERS; i++) {
        dispatch(pressurePipeline, cur === presA ? pressureBG0 : pressureBG1);
        const t = cur; cur = out; out = t;
      }
      dispatch(pfinishPipeline, cur === presA ? pfinishBG0 : pfinishBG1);
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
      rp.setPipeline(presentPipeline);
      rp.setBindGroup(0, presentBG);
      rp.draw(3);
      rp.end();
      device.queue.submit([enc.finish()]);
      frames++;
    };
    raf = requestAnimationFrame(step);

    return {
      ok: true,
      stop() {
        stopFlag = true;
        cancelAnimationFrame(raf);
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
      },
      frameCount: () => frames,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}