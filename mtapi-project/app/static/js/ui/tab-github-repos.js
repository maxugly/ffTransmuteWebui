/**
 * tab-github-repos.js — Central catalog & UI component for tab GitHub repository links.
 *
 * For tabs relying on upstream open-source repositories / tools:
 * - Single upstream repository: renders a direct <a> link with the GitHub SVG icon.
 * - Multiple upstream repositories: renders a <button> with the GitHub SVG icon + dropdown indicator (▾).
 *   Clicking toggles an accessible popover menu listing all relevant repositories with their labels/descriptions.
 * - Full HelpStrip integration: data-help-title and data-help-text, zero native title="" tooltips.
 */

export const GITHUB_ICON_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
</svg>`;

/**
 * Catalog of upstream repositories per navigation tab key.
 * Structure:
 *   tabKey: [ { name: string, url: string, desc: string }, ... ]
 */
export const TAB_GITHUB_REPOS = {
  // Sound & Analysis
  cdp: [
    {
      name: 'CDP8 (Composers Desktop Project)',
      url: 'https://github.com/ComposersDesktop/CDP8',
      desc: 'Official Composers Desktop Project Release 8 repository',
    },
    {
      name: 'cdp-wasm',
      url: 'https://github.com/cdp-wasm-suite/cdp-wasm',
      desc: 'WebAssembly port of the CDP sound transformation suite',
    },
  ],
  deepdive: [
    {
      name: 'demucs',
      url: 'https://github.com/facebookresearch/demucs',
      desc: 'Music source separation with Deep Neural Networks',
    },
    {
      name: 'essentia',
      url: 'https://github.com/MTG/essentia',
      desc: 'Audio analysis and audio-based music information retrieval',
    },
    {
      name: 'basic-pitch',
      url: 'https://github.com/spotify/basic-pitch',
      desc: "Spotify's neural network for audio-to-MIDI pitch detection",
    },
    {
      name: 'CDP8',
      url: 'https://github.com/ComposersDesktop/CDP8',
      desc: 'Composers Desktop Project sound transformations',
    },
  ],
  demucs: [
    {
      name: 'demucs (Facebook Research)',
      url: 'https://github.com/facebookresearch/demucs',
      desc: 'Hybrid Spectrogram and Waveform Neural Network for Music Source Separation',
    },
  ],
  mediacatalog: [
    {
      name: 'essentia (MTG)',
      url: 'https://github.com/MTG/essentia',
      desc: 'Music analysis and key/tempo/beat extraction library',
    },
    {
      name: 'basic-pitch',
      url: 'https://github.com/spotify/basic-pitch',
      desc: 'Audio-to-MIDI note transcription model',
    },
  ],
  music: [
    {
      name: 'ace-step (Gemelo AI)',
      url: 'https://github.com/gemelo-ai/ace-step',
      desc: 'ACE-Step fast text-to-music diffusion architecture',
    },
  ],

  // Ingest & Scraping
  ytdlp: [
    {
      name: 'yt-dlp',
      url: 'https://github.com/yt-dlp/yt-dlp',
      desc: 'Command-line audio/video downloader supporting 1,700+ websites',
    },
    {
      name: 'Seal (junkfood02)',
      url: 'https://github.com/junkfood02/Seal',
      desc: 'Video and audio downloader design reference with rich metadata retention',
    },
  ],

  // Segmentation & Backgrounds & Inpainting
  withoutbg: [
    {
      name: 'withoutbg-python',
      url: 'https://github.com/withoutbg/withoutbg-python',
      desc: 'Background removal via locally accelerated open weights or cloud API',
    },
  ],
  fastsam: [
    {
      name: 'FastSAM (CASIA-IVA-Lab)',
      url: 'https://github.com/CASIA-IVA-Lab/FastSAM',
      desc: 'Fast Segment Anything Model real-time segmentation',
    },
    {
      name: 'ultralytics',
      url: 'https://github.com/ultralytics/ultralytics',
      desc: 'YOLO and FastSAM inference pipeline framework',
    },
    {
      name: 'vjepa2 (Meta FAIR)',
      url: 'https://github.com/facebookresearch/vjepa2',
      desc: 'Self-supervised video models for understanding, prediction and planning',
    },
  ],
  erase: [
    {
      name: 'IOPaint (Sanster)',
      url: 'https://github.com/Sanster/IOPaint',
      desc: 'Image inpainting tool powered by SOTA AI models (LaMa, etc.)',
    },
    {
      name: 'lama (advimman)',
      url: 'https://github.com/advimman/lama',
      desc: 'Large Mask Inpainting for high resolution image restoration',
    },
  ],
  watermark: [
    {
      name: 'gemini-watermark-remover (GargantuaX)',
      url: 'https://github.com/GargantuaX/gemini-watermark-remover',
      desc: 'Automated watermark and overlay removal pipeline',
    },
  ],

  // Frame Ops & Interpolation & Generation
  rife: [
    {
      name: 'ECCV2022-RIFE (hzwer)',
      url: 'https://github.com/hzwer/ECCV2022-RIFE',
      desc: 'Real-Time Intermediate Flow Estimation for video frame interpolation',
    },
    {
      name: 'rife-ncnn-vulkan (nihui)',
      url: 'https://github.com/nihui/rife-ncnn-vulkan',
      desc: 'Vulkan neural compute RIFE acceleration binary',
    },
  ],
  riferecohere: [
    {
      name: 'ECCV2022-RIFE (hzwer)',
      url: 'https://github.com/hzwer/ECCV2022-RIFE',
      desc: 'Real-Time Intermediate Flow Estimation for video frame interpolation',
    },
    {
      name: 'rife-ncnn-vulkan (nihui)',
      url: 'https://github.com/nihui/rife-ncnn-vulkan',
      desc: 'Vulkan neural compute RIFE acceleration binary',
    },
  ],
  deepdream: [
    {
      name: 'deepdream (google)',
      url: 'https://github.com/google/deepdream',
      desc: 'Algorithmic hallucination and feature visualization in neural networks',
    },
  ],
  styletransfer: [
    {
      name: 'pytorch-CycleGAN-and-pix2pix (junyanz)',
      url: 'https://github.com/junyanz/pytorch-CycleGAN-and-pix2pix',
      desc: 'Image-to-Image translation in PyTorch',
    },
    {
      name: 'models (tensorflow)',
      url: 'https://github.com/tensorflow/models',
      desc: 'Arbitrary style transfer and deep convolutional models',
    },
  ],
  stablefluids: [
    {
      name: 'StableFluids (keijiro)',
      url: 'https://github.com/keijiro/StableFluids',
      desc: 'Navier-Stokes fluid dynamics simulation in WebGPU and Unity',
    },
  ],
  upscale: [
    {
      name: 'fastsdcpu (rupeshs)',
      url: 'https://github.com/rupeshs/fastsdcpu',
      desc: 'Fast Stable Diffusion and super-resolution upscalers on CPU/GPU',
    },
    {
      name: 'Real-ESRGAN (xinntao)',
      url: 'https://github.com/xinntao/Real-ESRGAN',
      desc: 'Practical algorithms for general image and video restoration',
    },
  ],

  // Core CLI & Tooling
  transmute: [
    {
      name: 'ffTransmuteWebui (maxugly)',
      url: 'https://github.com/maxugly/ffTransmuteWebui',
      desc: 'Fast, non-destructive video manipulation bash CLI + FastAPI + vanilla SPA',
    },
    {
      name: 'FFmpeg',
      url: 'https://github.com/FFmpeg/FFmpeg',
      desc: 'Complete cross-platform solution to record, convert, and stream audio and video',
    },
  ],
  advanced: [
    {
      name: 'ffTransmuteWebui (maxugly)',
      url: 'https://github.com/maxugly/ffTransmuteWebui',
      desc: 'Fast, non-destructive video manipulation bash CLI + FastAPI + vanilla SPA',
    },
  ],
  dart: [
    {
      name: 'ffTransmuteWebui (maxugly)',
      url: 'https://github.com/maxugly/ffTransmuteWebui',
      desc: 'Calendar Dart historical events and creative research tool',
    },
  ],
};

let activePopover = null;
let outsideClickListenerInstalled = false;

function closeActivePopover() {
  if (activePopover) {
    activePopover.classList.remove('is-open');
    activePopover = null;
  }
}

function handleOutsideClick(e) {
  if (!activePopover) return;
  if (!activePopover.contains(e.target)) {
    closeActivePopover();
  }
}

function handleKeyDown(e) {
  if (e.key === 'Escape' && activePopover) {
    closeActivePopover();
  }
}

/**
 * Updates or clears the GitHub header container based on the current tab.
 * @param {string} tabKey
 * @param {HTMLElement} [containerEl]
 */
export function updateTabGithubHeader(tabKey, containerEl) {
  const container = containerEl || document.getElementById('headerGithubWrap');
  if (!container) return;

  closeActivePopover();
  container.innerHTML = '';

  const repos = TAB_GITHUB_REPOS[tabKey];
  if (!repos || repos.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'inline-flex';

  if (!outsideClickListenerInstalled) {
    document.addEventListener('click', handleOutsideClick, true);
    document.addEventListener('keydown', handleKeyDown);
    outsideClickListenerInstalled = true;
  }

  if (repos.length === 1) {
    const r = repos[0];
    const link = document.createElement('a');
    link.className = 'btn-quick gh-tab-link';
    link.href = r.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.setAttribute('data-help-title', `${r.name} GitHub`);
    link.setAttribute('data-help-text', r.desc || `Open ${r.name} on GitHub`);
    link.setAttribute('aria-label', `${r.name} GitHub Repository`);
    link.innerHTML = GITHUB_ICON_SVG;
    container.appendChild(link);
    return;
  }

  // Multiple repositories: render dropdown toggle button + popover menu
  const wrap = document.createElement('div');
  wrap.className = 'gh-tab-dropdown-wrap';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-quick gh-tab-dropdown-btn';
  btn.setAttribute('data-help-title', 'GitHub Repositories');
  btn.setAttribute('data-help-text', `View ${repos.length} upstream open-source repositories powering this tab`);
  btn.setAttribute('aria-label', 'Open upstream GitHub repositories menu');
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = `${GITHUB_ICON_SVG}<span class="gh-dropdown-arrow" aria-hidden="true">▾</span>`;

  const popover = document.createElement('div');
  popover.className = 'gh-repo-popover';
  popover.setAttribute('role', 'menu');

  const popoverHeader = document.createElement('div');
  popoverHeader.className = 'gh-popover-header';
  popoverHeader.textContent = 'Upstream Repositories';
  popover.appendChild(popoverHeader);

  repos.forEach((r) => {
    const item = document.createElement('a');
    item.className = 'gh-popover-item';
    item.href = r.url;
    item.target = '_blank';
    item.rel = 'noopener noreferrer';
    item.setAttribute('role', 'menuitem');
    item.setAttribute('data-help-title', `${r.name} GitHub`);
    item.setAttribute('data-help-text', r.desc || `Open ${r.name} on GitHub`);

    const iconSpan = document.createElement('span');
    iconSpan.className = 'gh-popover-icon';
    iconSpan.innerHTML = GITHUB_ICON_SVG;

    const content = document.createElement('div');
    content.className = 'gh-popover-content';

    const name = document.createElement('span');
    name.className = 'gh-popover-name';
    name.textContent = r.name;

    const desc = document.createElement('span');
    desc.className = 'gh-popover-desc';
    desc.textContent = r.desc;

    content.appendChild(name);
    if (r.desc) content.appendChild(desc);

    item.appendChild(iconSpan);
    item.appendChild(content);
    popover.appendChild(item);
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = wrap.classList.contains('is-open');
    closeActivePopover();
    if (!isOpen) {
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      activePopover = wrap;
    } else {
      btn.setAttribute('aria-expanded', 'false');
    }
  });

  wrap.appendChild(btn);
  wrap.appendChild(popover);
  container.appendChild(wrap);
}
