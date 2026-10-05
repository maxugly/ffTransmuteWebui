// yt-dlp Media Downloader Tab
import { state, elements, logConsole, formatBytes } from '/app.js?v=2';
import { escapeHtml, basename, formatDurationExact } from '/js/utils.js';
import { addPathsToPool } from '/js/pool/items.js';
import { addPathToSequence } from '/js/pool/sequence.js';
import { scheduleSavePoolState } from '/js/pool/persistence.js?v=2';
import { openCommentsForPath } from '/js/tabs/comments.js';

let _activeProbeData = null;
let _isDownloading = false;

function renderYtdlpForm() {
  const panel = elements.actionPanel;
  if (!panel) return;

  panel.innerHTML = `
    <div class="ytdlp-workspace">
      <!-- Top URL Bar -->
      <div class="ytdlp-top-bar">
        <div class="ytdlp-url-group">
          <label for="ytdlpUrl" class="ytdlp-label">Media URL:</label>
          <input type="text" id="ytdlpUrl" class="text-input ytdlp-url-input"
            placeholder="Paste YouTube, Vimeo, Twitter/X, TikTok, Reddit, or 1700+ site URL…"
            autocomplete="off" spellcheck="false"
            data-help-title="Media URL" data-help-text="Enter any video or playlist URL supported by yt-dlp.">
          <button type="button" class="btn" id="btnYtdlpPaste" data-help-title="Paste URL" data-help-text="Paste URL from clipboard.">Paste</button>
          <button type="button" class="btn btn-primary" id="btnYtdlpProbe" data-help-title="Inspect URL" data-help-text="Probe video metadata, title, author, and available stream resolutions without downloading.">Probe / Info</button>
        </div>
      </div>

      <!-- Preview Inspector Card (revealed upon probe) -->
      <div id="ytdlpProbeCard" class="ytdlp-probe-card" hidden>
        <div class="ytdlp-probe-thumb-wrap">
          <img id="ytdlpProbeThumb" class="ytdlp-probe-thumb" src="" alt="Thumbnail">
        </div>
        <div class="ytdlp-probe-meta">
          <div class="ytdlp-probe-title" id="ytdlpProbeTitle">—</div>
          <div class="ytdlp-probe-subline" id="ytdlpProbeSubline">—</div>
          <div class="ytdlp-probe-stats" id="ytdlpProbeStats">—</div>
          <div class="ytdlp-probe-resolutions" id="ytdlpProbeResolutions"></div>
          <button type="button" class="btn btn-mini" id="btnYtdlpViewComments" style="margin-top: 8px; display: none;" data-help-title="View Comments" data-help-text="Switch to the Comments tab to view threaded Reddit-style comments for this video.">💬 View Comments</button>
        </div>
      </div>

      <!-- Options Banks Grid -->
      <div class="ytdlp-banks-grid">
        <!-- Bank 1: Mode & Time Range -->
        <div class="ytdlp-bank">
          <div class="ytdlp-bank-title">1. Mode & Time Range</div>
          <div class="form-row ytdlp-row">
            <label class="field-label">Type:</label>
            <div class="button-group">
              <button type="button" class="btn btn-mode active" id="btnYtdlpModeVideo">Video</button>
              <button type="button" class="btn btn-mode" id="btnYtdlpModeAudio">Audio Only</button>
            </div>
          </div>
          <div class="form-row ytdlp-row">
            <label class="field-label" data-help-title="Time Range" data-help-text="Download only a specific section of the video (HH:MM:SS or seconds).">Clip Section:</label>
            <div class="ytdlp-timerange-inputs">
              <input type="text" id="ytdlpStart" class="text-input text-mini" placeholder="00:00:00" data-help-title="Start Timestamp" data-help-text="Clip start timestamp (e.g. 00:01:30 or 90).">
              <span class="ytdlp-range-sep">to</span>
              <input type="text" id="ytdlpEnd" class="text-input text-mini" placeholder="end" data-help-title="End Timestamp" data-help-text="Clip end timestamp (e.g. 00:03:00 or 180).">
            </div>
          </div>
          <div class="form-row ytdlp-row">
            <label class="field-label">Playlist:</label>
            <input type="text" id="ytdlpPlaylistItems" class="text-input text-mini" placeholder="Single clip (or e.g. 1-5)" data-help-title="Playlist Items" data-help-text="Leave empty for single video, or specify range like 1-5 or 1,3,7 for playlist items.">
          </div>
        </div>

        <!-- Bank 2: Quality & Codecs -->
        <div class="ytdlp-bank">
          <div class="ytdlp-bank-title">2. Quality & Codecs</div>
          <div class="form-row ytdlp-row" id="rowYtdlpQuality">
            <label for="ytdlpVideoQuality" class="field-label">Max Res:</label>
            <select id="ytdlpVideoQuality" class="select-input select-mini" data-help-title="Video Quality" data-help-text="Limit maximum video height resolution.">
              <option value="best" selected>Best available</option>
              <option value="2160">2160p (4K)</option>
              <option value="1440">1440p (2K)</option>
              <option value="1080">1080p (FHD)</option>
              <option value="720">720p (HD)</option>
              <option value="480">480p (SD)</option>
            </select>
          </div>
          <div class="form-row ytdlp-row" id="rowYtdlpContainer">
            <label for="ytdlpVideoFormat" class="field-label">Container:</label>
            <select id="ytdlpVideoFormat" class="select-input select-mini" data-help-title="Video Container" data-help-text="Output container format.">
              <option value="mp4" selected>MP4</option>
              <option value="mkv">MKV</option>
              <option value="webm">WebM</option>
              <option value="original">Original</option>
            </select>
          </div>
          <div class="form-row ytdlp-row" id="rowYtdlpAudioFormat" hidden>
            <label for="ytdlpAudioFormat" class="field-label">Audio Fmt:</label>
            <select id="ytdlpAudioFormat" class="select-input select-mini" data-help-title="Audio Format" data-help-text="Target extracted audio format.">
              <option value="mp3" selected>MP3</option>
              <option value="m4a">M4A (AAC)</option>
              <option value="opus">OPUS</option>
              <option value="flac">FLAC</option>
              <option value="wav">WAV</option>
              <option value="aac">AAC</option>
            </select>
          </div>
          <div class="form-row ytdlp-row" id="rowYtdlpAudioQuality" hidden>
            <label for="ytdlpAudioQuality" class="field-label">Bitrate:</label>
            <select id="ytdlpAudioQuality" class="select-input select-mini" data-help-title="Audio Bitrate" data-help-text="VBR 0 (highest quality) or explicit bitrate.">
              <option value="0" selected>Best (VBR 0)</option>
              <option value="320k">320 kbps</option>
              <option value="256k">256 kbps</option>
              <option value="192k">192 kbps</option>
              <option value="128k">128 kbps</option>
            </select>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Multi-Audio Streams" data-help-text="Keep all available audio language streams.">
              <input type="checkbox" id="ytdlpMultiAudio"> Multi-audio streams
            </label>
          </div>
        </div>

        <!-- Bank 3: Captions & Chat -->
        <div class="ytdlp-bank">
          <div class="ytdlp-bank-title">3. Captions & Live Chat</div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Download Subtitles" data-help-text="Download subtitle files.">
              <input type="checkbox" id="ytdlpWriteSubs"> Subtitles
            </label>
            <label class="checkbox-label" data-help-title="Auto-generated Subtitles" data-help-text="Include automatic speech-to-text captions.">
              <input type="checkbox" id="ytdlpAutoSubs"> Auto-subs
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpSubLangs" class="field-label">Langs:</label>
            <input type="text" id="ytdlpSubLangs" class="text-input text-mini" value="en.*,all" data-help-title="Subtitle Languages" data-help-text="Comma-separated language codes or regex (e.g. en.*,es,ja).">
          </div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpSubFormat" class="field-label">Format:</label>
            <select id="ytdlpSubFormat" class="select-input select-mini" data-help-title="Subtitle Format" data-help-text="Target format for converted subtitles.">
              <option value="srt" selected>SRT</option>
              <option value="vtt">VTT</option>
              <option value="ass">ASS</option>
            </select>
            <label class="checkbox-label" data-help-title="Embed Subtitles" data-help-text="Embed subtitles into the MP4/MKV container.">
              <input type="checkbox" id="ytdlpEmbedSubs"> Embed
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Live Chat Replay" data-help-text="Download live chat replay as companion .live_chat.json file.">
              <input type="checkbox" id="ytdlpLiveChat"> Download Live Chat (.json)
            </label>
          </div>
        </div>

        <!-- Bank 4: Metadata & Assets -->
        <div class="ytdlp-bank">
          <div class="ytdlp-bank-title">4. Metadata & Companion Assets</div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Write Description" data-help-text="Save video description text to companion .description file.">
              <input type="checkbox" id="ytdlpDescription" checked> Description (.description)
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Write Comments" data-help-text="Fetch video comments into companion .info.json separately after media download completes.">
              <input type="checkbox" id="ytdlpComments"> Comments (after media)
            </label>
            <label for="ytdlpMaxComments" class="field-label" style="margin-left: 8px;">Max:</label>
            <input type="number" id="ytdlpMaxComments" class="text-input text-mini" value="0" min="0" max="100000" style="max-width: 80px;" placeholder="0 (all)" data-help-title="Max Comments" data-help-text="Maximum comments to retrieve (0 = all / unlimited, or enter a specific count).">
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Write Info JSON" data-help-text="Save complete metadata to companion .info.json.">
              <input type="checkbox" id="ytdlpInfoJson" checked> Full .info.json
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label" data-help-title="Save Thumbnail" data-help-text="Save thumbnail image file.">
              <input type="checkbox" id="ytdlpThumbnail" checked> Thumbnail file
            </label>
            <label class="checkbox-label" data-help-title="Embed Thumbnail" data-help-text="Embed thumbnail image into media tags.">
              <input type="checkbox" id="ytdlpEmbedThumb"> Embed
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpSponsorBlock" class="field-label">SponsorBlock:</label>
            <select id="ytdlpSponsorBlock" class="select-input select-mini" data-help-title="SponsorBlock" data-help-text="Automatically mark chapters or remove sponsor segments.">
              <option value="none" selected>None</option>
              <option value="mark">Mark chapters</option>
              <option value="remove">Remove segments</option>
            </select>
          </div>
        </div>

        <!-- Bank 5: Network & Performance -->
        <div class="ytdlp-bank">
          <div class="ytdlp-bank-title">5. Network & Engine</div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpThreads" class="field-label">Threads (-N):</label>
            <input type="number" id="ytdlpThreads" class="text-input text-mini" value="4" min="1" max="16" data-help-title="Concurrent Fragments" data-help-text="Number of parallel connections for DASH/HLS native streams.">
            <label class="checkbox-label" data-help-title="aria2c" data-help-text="Use aria2c external downloader if installed.">
              <input type="checkbox" id="ytdlpAria2c"> aria2c
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpCookiesBrowser" class="field-label">Cookies:</label>
            <select id="ytdlpCookiesBrowser" class="select-input select-mini" data-help-title="Cookies Source" data-help-text="Extract cookies from browser for age-restricted or member-only videos.">
              <option value="" selected>None</option>
              <option value="chrome">Chrome</option>
              <option value="firefox">Firefox</option>
              <option value="brave">Brave</option>
              <option value="chromium">Chromium</option>
            </select>
            <label class="checkbox-label" data-help-title="Force IPv4" data-help-text="Force IPv4 network connection.">
              <input type="checkbox" id="ytdlpIpv4"> IPv4
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpProxy" class="field-label">Proxy:</label>
            <input type="text" id="ytdlpProxy" class="text-input text-mini" placeholder="Optional http://..." data-help-title="Proxy" data-help-text="HTTP or SOCKS5 proxy URL.">
          </div>
        </div>

        <!-- Bank 6: Destination & Ingest Actions -->
        <div class="ytdlp-bank">
          <div class="ytdlp-bank-title">6. Ingest Actions & Destination</div>
          <div class="form-row ytdlp-row">
            <label for="ytdlpOutDir" class="field-label">Folder:</label>
            <div class="ytdlp-dir-picker">
              <input type="text" id="ytdlpOutDir" class="text-input text-mini" placeholder="~/Downloads" data-help-title="Output Directory" data-help-text="Destination folder for downloaded media and sidecars.">
              <button type="button" class="btn" id="btnYtdlpBrowseDir">Browse…</button>
            </div>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label ytdlp-ingest-action" data-help-title="Add to Video Pool" data-help-text="Automatically add downloaded video to the Video Pool with full source metadata.">
              <input type="checkbox" id="ytdlpAddPool" checked> <strong>Add to Video Pool</strong> (with metadata)
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label ytdlp-ingest-action" data-help-title="Send to Media In" data-help-text="Set downloaded file as the global Media In input.">
              <input type="checkbox" id="ytdlpSendMediaIn"> Send to Media In
            </label>
          </div>
          <div class="form-row ytdlp-row">
            <label class="checkbox-label ytdlp-ingest-action" data-help-title="Append to Sequence" data-help-text="Append downloaded video to the stitch sequence.">
              <input type="checkbox" id="ytdlpAddSequence"> Append to Sequence
            </label>
          </div>
        </div>
      </div>

      <!-- Action Strip -->
      <div class="ytdlp-action-strip">
        <button type="button" class="btn btn-primary btn-large" id="btnYtdlpDownload" data-help-title="Download Media" data-help-text="Start downloading with the configured options.">
          Download Media
        </button>
        <button type="button" class="btn" id="btnYtdlpDryRun" data-help-title="Dry Run" data-help-text="Print resolved yt-dlp command line without downloading.">
          Dry Run
        </button>
        <div class="ytdlp-status-bar" id="ytdlpStatusBar">
          <span class="ytdlp-status-text" id="ytdlpStatusText">Ready</span>
        </div>
      </div>
    </div>
  `;

  _bindEvents();
}

function _bindEvents() {
  const $ = (id) => document.getElementById(id);

  // Paste button
  $('btnYtdlpPaste')?.addEventListener('click', async () => {
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText();
        if (text && text.trim().startsWith('http')) {
          $('ytdlpUrl').value = text.trim();
          _doProbe(text.trim());
          return;
        }
      }
    } catch (_) { /* ignore clipboard errors */ }
    const url = prompt('Paste media URL:');
    if (url && url.trim()) {
      $('ytdlpUrl').value = url.trim();
      _doProbe(url.trim());
    }
  });

  // Probe button
  $('btnYtdlpProbe')?.addEventListener('click', () => {
    const url = $('ytdlpUrl')?.value?.trim();
    if (url) _doProbe(url);
    else alert('Please enter a URL first.');
  });

  $('ytdlpUrl')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = $('ytdlpUrl')?.value?.trim();
      if (url) _doProbe(url);
    }
  });

  // Mode toggles
  $('btnYtdlpModeVideo')?.addEventListener('click', () => {
    $('btnYtdlpModeVideo').classList.add('active');
    $('btnYtdlpModeAudio').classList.remove('active');
    $('rowYtdlpQuality').hidden = false;
    $('rowYtdlpContainer').hidden = false;
    $('rowYtdlpAudioFormat').hidden = true;
    $('rowYtdlpAudioQuality').hidden = true;
  });

  $('btnYtdlpModeAudio')?.addEventListener('click', () => {
    $('btnYtdlpModeAudio').classList.add('active');
    $('btnYtdlpModeVideo').classList.remove('active');
    $('rowYtdlpQuality').hidden = true;
    $('rowYtdlpContainer').hidden = true;
    $('rowYtdlpAudioFormat').hidden = false;
    $('rowYtdlpAudioQuality').hidden = false;
  });

  // Browse folder
  $('btnYtdlpBrowseDir')?.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/picker?mode=dir');
      if (res.ok) {
        const data = await res.json();
        if (data.path) $('ytdlpOutDir').value = data.path;
      }
    } catch (err) {
      logConsole(`[YTDLP]: Folder picker error: ${err.message}`, 'error');
    }
  });

  // Download & Dry Run
  $('btnYtdlpDownload')?.addEventListener('click', () => _startDownload(false));
  $('btnYtdlpDryRun')?.addEventListener('click', () => _startDownload(true));
}

async function _doProbe(url) {
  const card = document.getElementById('ytdlpProbeCard');
  const statusText = document.getElementById('ytdlpStatusText');
  if (statusText) statusText.textContent = 'Probing URL metadata…';

  try {
    const res = await fetch(`/api/ytdlp/info?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    if (!data.ok) {
      if (statusText) statusText.textContent = `Probe failed: ${data.error || 'unknown'}`;
      logConsole(`[YTDLP PROBE ERROR]: ${data.error}`, 'error');
      return;
    }

    _activeProbeData = data.info;
    const info = data.info;

    if (card) card.hidden = false;
    const thumbEl = document.getElementById('ytdlpProbeThumb');
    if (thumbEl) thumbEl.src = info.thumbnail || '';

    const titleEl = document.getElementById('ytdlpProbeTitle');
    if (titleEl) titleEl.textContent = info.title || 'Untitled';

    const sublineEl = document.getElementById('ytdlpProbeSubline');
    if (sublineEl) {
      const parts = [
        info.author ? `By: ${info.author}` : null,
        info.upload_date ? `Date: ${info.upload_date}` : null,
        info.duration ? `Duration: ${formatDurationExact(info.duration)}` : null,
        info.site ? `Site: ${info.site}` : (info.is_youtube ? 'Site: YouTube' : null),
      ].filter(Boolean);
      sublineEl.textContent = parts.join(' · ');
    }

    const statsEl = document.getElementById('ytdlpProbeStats');
    if (statsEl) {
      const stats = [];
      if (info.view_count != null) stats.push(`${Number(info.view_count).toLocaleString()} views`);
      if (info.like_count != null) stats.push(`${Number(info.like_count).toLocaleString()} likes`);
      if (info.tags?.length) stats.push(`Tags: ${info.tags.slice(0, 6).join(', ')}`);
      statsEl.textContent = stats.join(' · ') || '';

      if (info.is_youtube && info.id) {
        _fetchRydForProbe(info.id, statsEl);
      }
    }

    const resEl = document.getElementById('ytdlpProbeResolutions');
    if (resEl && info.available_resolutions?.length) {
      resEl.innerHTML = `<span class="ytdlp-pill-label">Streams:</span> ` +
        info.available_resolutions.slice(0, 8).map(h => `<span class="ytdlp-stream-pill">${h}p</span>`).join(' ');
    }

    if (statusText) statusText.textContent = `Probed: ${info.title}`;
    logConsole(`[YTDLP]: Probed "${info.title}" (${info.author || 'web'})`);
  } catch (err) {
    if (statusText) statusText.textContent = `Probe error: ${err.message}`;
    logConsole(`[YTDLP ERROR]: ${err.message}`, 'error');
  }
}

async function _fetchRydForProbe(videoId, statsEl) {
  try {
    const res = await fetch(`/api/ytdlp/ryd?video_id=${encodeURIComponent(videoId)}`);
    const ryd = await res.json();
    if (!ryd.ok || !statsEl) return;
    if (_activeProbeData?.id !== videoId) return;

    let badge = statsEl.querySelector('.ytdlp-ryd-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ytdlp-ryd-badge';
      statsEl.appendChild(badge);
    }
    const likesStr = _formatCompact(ryd.likes);
    const dislikesStr = _formatCompact(ryd.dislikes);
    badge.innerHTML = `
      <span class="ytdlp-ryd-likes" title="${Number(ryd.likes).toLocaleString()} likes">👍 ${likesStr}</span>
      <span class="ytdlp-ryd-dislikes" title="${Number(ryd.dislikes).toLocaleString()} dislikes">👎 ${dislikesStr}</span>
      <span class="ytdlp-ryd-ratio">(${ryd.like_ratio}%)</span>
    `;
    badge.title = `Return YouTube Dislike: ${Number(ryd.likes).toLocaleString()} likes vs ${Number(ryd.dislikes).toLocaleString()} dislikes (${ryd.like_ratio}%)`;
  } catch (e) {
    // Ignore network failures for non-critical RYD stat
  }
}

function _formatCompact(num) {
  if (num == null) return '0';
  const n = Number(num);
  if (isNaN(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function _collectParams(isDryRun) {
  const $ = (id) => document.getElementById(id);
  const isAudio = $('btnYtdlpModeAudio')?.classList.contains('active');

  return {
    url: $('ytdlpUrl')?.value?.trim() || '',
    output_dir: $('ytdlpOutDir')?.value?.trim() || null,
    extract_audio: isAudio,
    video_quality: $('ytdlpVideoQuality')?.value || 'best',
    video_format: $('ytdlpVideoFormat')?.value || 'mp4',
    audio_format: $('ytdlpAudioFormat')?.value || 'mp3',
    audio_quality: $('ytdlpAudioQuality')?.value || '0',
    audio_multistreams: !!$('ytdlpMultiAudio')?.checked,

    time_range_start: $('ytdlpStart')?.value?.trim() || null,
    time_range_end: $('ytdlpEnd')?.value?.trim() || null,

    write_subs: !!$('ytdlpWriteSubs')?.checked,
    write_auto_subs: !!$('ytdlpAutoSubs')?.checked,
    sub_langs: $('ytdlpSubLangs')?.value?.trim() || 'en.*,all',
    sub_format: $('ytdlpSubFormat')?.value || 'srt',
    embed_subs: !!$('ytdlpEmbedSubs')?.checked,
    write_live_chat: !!$('ytdlpLiveChat')?.checked,

    write_description: !!$('ytdlpDescription')?.checked,
    write_comments: !!$('ytdlpComments')?.checked,
    max_comments: Number($('ytdlpMaxComments')?.value || 100),
    write_info_json: !!$('ytdlpInfoJson')?.checked,
    write_thumbnail: !!$('ytdlpThumbnail')?.checked,
    embed_thumbnail: !!$('ytdlpEmbedThumb')?.checked,

    sponsorblock_action: $('ytdlpSponsorBlock')?.value || 'none',

    concurrent_fragments: Number($('ytdlpThreads')?.value || 4),
    use_aria2c: !!$('ytdlpAria2c')?.checked,
    proxy_url: $('ytdlpProxy')?.value?.trim() || null,
    cookies_from_browser: $('ytdlpCookiesBrowser')?.value || null,
    force_ipv4: !!$('ytdlpIpv4')?.checked,

    add_to_pool: !!$('ytdlpAddPool')?.checked,
    send_to_media_in: !!$('ytdlpSendMediaIn')?.checked,
    add_to_sequence: !!$('ytdlpAddSequence')?.checked,

    dry_run: isDryRun,
  };
}

async function _startDownload(isDryRun) {
  if (_isDownloading) return;
  const params = _collectParams(isDryRun);
  if (!params.url) {
    alert('Please enter a media URL.');
    return;
  }

  const statusText = document.getElementById('ytdlpStatusText');
  const btnRun = document.getElementById('btnYtdlpDownload');
  const btnDry = document.getElementById('btnYtdlpDryRun');

  _isDownloading = true;
  if (btnRun) btnRun.disabled = true;
  if (btnDry) btnDry.disabled = true;
  if (statusText) statusText.textContent = isDryRun ? 'Executing dry run…' : 'Starting download…';

  try {
    const res = await fetch('/ops/ytdlp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Server returned HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }
    const data = await res.json();

    if (!data.ok) {
      if (statusText) statusText.textContent = `Failed: ${data.error || 'error'}`;
      logConsole(`[YTDLP ERROR]: ${data.error}\n${data.stderr || ''}`, 'error');
      alert(`Download failed: ${data.error}`);
      return;
    }

    if (isDryRun) {
      if (statusText) statusText.textContent = 'Dry run complete (see console)';
      logConsole(`[YTDLP DRY RUN]:\nCommand: ${data.command}\n${data.stdout}`);
      return;
    }

    // Success real download
    const outPath = data.output_path;
    const sourceMeta = data.meta?.source_meta || null;
    const elapsed = data.meta?.elapsed_s || '';

    logConsole(`[YTDLP SUCCESS]: Downloaded ${basename(outPath)} (${elapsed}s)`);
    if (statusText) statusText.textContent = `Complete: ${basename(outPath)} (${elapsed}s)`;

    if (sourceMeta && (sourceMeta.comments_json_path || sourceMeta.info_json_path)) {
      const commBtn = document.getElementById('btnYtdlpViewComments');
      if (commBtn) {
        commBtn.style.display = 'inline-block';
        commBtn.onclick = () => {
          openCommentsForPath(sourceMeta.comments_json_path || sourceMeta.info_json_path);
        };
      }
    }

    // Ingest actions
    if (params.add_to_pool && outPath) {
      const { added } = await addPathsToPool([outPath]);
      if (added > 0 && sourceMeta) {
        const item = state.pool.items.find(i => i.path === outPath);
        if (item) {
          item.source_meta = sourceMeta;
          scheduleSavePoolState();
        }
      }
      logConsole(`[YTDLP]: Ingested into Video Pool with metadata.`);
    }

    if (params.send_to_media_in && outPath) {
      const gi = document.getElementById('giMediaIn');
      if (gi) {
        gi.value = outPath;
        gi.dispatchEvent(new Event('input', { bubbles: true }));
        logConsole(`[YTDLP]: Sent ${basename(outPath)} to Media In.`);
      }
    }

    if (params.add_to_sequence && outPath) {
      addPathToSequence(outPath);
      logConsole(`[YTDLP]: Appended ${basename(outPath)} to Sequence.`);
    }
  } catch (err) {
    if (statusText) statusText.textContent = `Error: ${err.message}`;
    logConsole(`[YTDLP ERROR]: ${err.message}`, 'error');
  } finally {
    _isDownloading = false;
    if (btnRun) btnRun.disabled = false;
    if (btnDry) btnDry.disabled = false;
  }
}

export { renderYtdlpForm };
