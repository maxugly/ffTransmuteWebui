import { elements, state, logConsole, switchTab } from '/app.js';

/**
 * Agent tab — chat + images via grok/agy CLI backends.
 */

function _ensureAgentState() {
  if (!state.agent) {
    state.agent = {
      backend: 'deepseek',
      skill: 'chat',
      model: '',
      images: [],
      history: [],
    };
  }
  if (state.agent.model == null) state.agent.model = '';
  return state.agent;
}

function renderAgentForm() {
  var a = _ensureAgentState();
  var histHtml = (a.history || []).map(function(t) {
    var role = t.role === 'assistant' ? 'agent' : 'you';
    var cls = t.role === 'assistant' ? 'agent-msg-asst' : 'agent-msg-user';
    return `<div class="agent-msg ${cls}"><span class="agent-role">${role}</span> ${escapeAgent(t.content)}</div>`;
  }).join('') || '<div class="agent-msg agent-msg-empty">No messages yet. Attach an image and pick a skill.</div>';

  var imgHtml = (a.images || []).map(function(p, i) {
    var name = p.split('/').pop();
    return `<div class="agent-img-row" data-idx="${i}">
      <span class="agent-img-path" title="${escapeAgent(p)}">${escapeAgent(name)}</span>
      <button type="button" class="btn agent-img-rm" data-idx="${i}" title="Remove">✕</button>
    </div>`;
  }).join('') || '<div class="form-row-hint">No images attached</div>';

  var html = `
    <div class="panel-title-desc dense">
      <h3>Agent · vision chat</h3>
      <p class="dream-hint">
        CLI: <strong>grok</strong> / <strong>agy</strong> · API: <strong>DeepSeek</strong> / OpenRouter / xAI / OpenAI
        (keys from <code>~/.secrets</code>). SD1.5 skill → short CLIP prompt for Img2Img.
        DeepSeek is <strong>text-only</strong> (no pixel vision).
      </p>
    </div>

    <div class="form-row">
      <label for="agBackend">Backend</label>
      <select id="agBackend">
        <option value="grok" ${a.backend === 'grok' ? 'selected' : ''}>grok CLI (vision)</option>
        <option value="agy" ${a.backend === 'agy' ? 'selected' : ''}>agy CLI (vision)</option>
        <option value="deepseek" ${a.backend === 'deepseek' ? 'selected' : ''}>DeepSeek API (text)</option>
        <option value="openrouter" ${a.backend === 'openrouter' ? 'selected' : ''}>OpenRouter API (vision)</option>
        <option value="xai" ${a.backend === 'xai' ? 'selected' : ''}>xAI Grok API (vision)</option>
        <option value="openai" ${a.backend === 'openai' ? 'selected' : ''}>OpenAI API (vision)</option>
        <option value="groq" ${a.backend === 'groq' ? 'selected' : ''}>Groq API (text)</option>
        <option value="stub" ${a.backend === 'stub' ? 'selected' : ''}>stub (offline)</option>
      </select>
      <label for="agSkill">Skill</label>
      <select id="agSkill">
        <option value="chat" ${a.skill === 'chat' ? 'selected' : ''}>Chat</option>
        <option value="sd15_prompt" ${a.skill === 'sd15_prompt' ? 'selected' : ''}>SD1.5 prompt</option>
        <option value="caption" ${a.skill === 'caption' ? 'selected' : ''}>Caption</option>
      </select>
    </div>

    <div class="form-row">
      <label>Images</label>
      <div class="sort-toolbar" style="margin:0; flex:1">
        <button type="button" class="btn" id="btnAgAddImg">+ Image</button>
        <button type="button" class="btn" id="btnAgClearImg" ${a.images.length ? '' : 'disabled'}>Clear</button>
      </div>
    </div>
    <div class="agent-img-list" id="agImgList">${imgHtml}</div>

    <div class="agent-transcript" id="agTranscript">${histHtml}</div>

    <div class="form-row">
      <label for="agModel">Model</label>
      <input type="text" id="agModel" placeholder="blank = provider default" value="${escapeAgent(a.model || '')}" style="flex:1 1 12rem">
      <p class="form-row-hint">DeepSeek: deepseek-chat · OpenRouter: openai/gpt-4o-mini · xAI: grok-2-vision-1212</p>
    </div>

    <div class="form-row">
      <label for="agMessage">Message</label>
      <input type="text" id="agMessage" placeholder="Ask about the image, or leave blank for SD1.5 skill" style="flex:1 1 14rem">
      <button type="button" class="btn btn-primary" id="btnAgSend">Send</button>
    </div>

    <div class="form-row" style="margin-top:6px">
      <button type="button" class="btn" id="btnAgCopy">Copy last</button>
      <button type="button" class="btn" id="btnAgToI2i">→ Img2Img</button>
      <button type="button" class="btn" id="btnAgToT2i">→ Txt2Img</button>
      <button type="button" class="btn" id="btnAgClearHist">Clear chat</button>
    </div>

    <section class="tool-docs" aria-label="About agent">
      <h4 class="tool-docs-title">About · Agent</h4>
      <p class="tool-docs-lede">
        Uses CLI vision agents already on this machine (same pattern as tilagup).
        SD1.5 skill returns ≤~50 words, comma phrases, for OpenVINO img2img.
      </p>
    </section>
  `;
  elements.actionPanel.innerHTML = html;

  document.getElementById('agBackend')?.addEventListener('change', function(e) {
    a.backend = e.target.value;
  });
  document.getElementById('agSkill')?.addEventListener('change', function(e) {
    a.skill = e.target.value;
  });
  document.getElementById('agModel')?.addEventListener('change', function(e) {
    a.model = e.target.value.trim();
  });
  document.getElementById('agModel')?.addEventListener('input', function(e) {
    a.model = e.target.value.trim();
  });

  document.getElementById('btnAgAddImg')?.addEventListener('click', async function() {
    try {
      var res = await fetch('/api/picker?mode=files&filter=image&start_path=');
      if (!res.ok) throw new Error(await res.text());
      var data = await res.json();
      var paths = data.paths || (data.path ? [data.path] : []);
      paths.forEach(function(p) {
        if (p && a.images.indexOf(p) < 0) a.images.push(p);
      });
      renderAgentForm();
    } catch (err) {
      alert('Picker failed: ' + err.message);
    }
  });

  document.getElementById('btnAgClearImg')?.addEventListener('click', function() {
    a.images = [];
    renderAgentForm();
  });

  document.querySelectorAll('.agent-img-rm').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var i = parseInt(btn.getAttribute('data-idx'), 10);
      if (!isNaN(i)) {
        a.images.splice(i, 1);
        renderAgentForm();
      }
    });
  });

  document.getElementById('btnAgSend')?.addEventListener('click', function() {
    sendAgentMessage();
  });
  document.getElementById('agMessage')?.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAgentMessage();
    }
  });

  document.getElementById('btnAgCopy')?.addEventListener('click', function() {
    var last = _lastAssistant();
    if (!last) { alert('Nothing to copy'); return; }
    navigator.clipboard?.writeText(last).then(function() {
      logConsole('[AGENT]: copied last reply');
    }).catch(function() {
      prompt('Copy:', last);
    });
  });

  document.getElementById('btnAgToI2i')?.addEventListener('click', function() {
    var prompt = _lastPromptOrText();
    if (!prompt) { alert('No assistant text yet'); return; }
    // stash for img2img form
    state.agent._pendingI2iPrompt = prompt;
    if (a.images[0]) state.agent._pendingI2iImage = a.images[0];
    if (typeof switchTab === 'function') switchTab('img2img');
    else logConsole('[AGENT]: switch to Img2Img and paste prompt');
  });

  document.getElementById('btnAgToT2i')?.addEventListener('click', function() {
    var prompt = _lastPromptOrText();
    if (!prompt) { alert('No assistant text yet'); return; }
    state.agent._pendingT2iPrompt = prompt;
    if (typeof switchTab === 'function') switchTab('txt2img');
  });

  document.getElementById('btnAgClearHist')?.addEventListener('click', function() {
    a.history = [];
    renderAgentForm();
  });

  var tr = document.getElementById('agTranscript');
  if (tr) tr.scrollTop = tr.scrollHeight;
}

function escapeAgent(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _lastAssistant() {
  var a = _ensureAgentState();
  for (var i = a.history.length - 1; i >= 0; i--) {
    if (a.history[i].role === 'assistant') return a.history[i].content;
  }
  return '';
}

function _lastPromptOrText() {
  var t = _lastAssistant();
  if (!t) return '';
  // strip PROMPT: prefix if present
  var m = t.match(/^PROMPT:\s*(.+)$/im);
  if (m) return m[1].trim();
  return t.trim();
}

async function sendAgentMessage() {
  var a = _ensureAgentState();
  var msg = (document.getElementById('agMessage')?.value || '').trim();
  a.backend = document.getElementById('agBackend')?.value || a.backend;
  a.skill = document.getElementById('agSkill')?.value || a.skill;

  if (a.skill !== 'chat' && !a.images.length) {
    alert('Attach at least one image for this skill.');
    return;
  }
  if (a.skill === 'chat' && !msg && !a.images.length) {
    alert('Type a message or attach an image.');
    return;
  }

  var userDisplay = msg || (a.skill === 'sd15_prompt' ? '(SD1.5 prompt from image)' : '(caption)');
  a.history.push({ role: 'user', content: userDisplay });
  if (document.getElementById('agMessage')) document.getElementById('agMessage').value = '';
  renderAgentForm();

  a.model = (document.getElementById('agModel')?.value || '').trim();
  var body = {
    backend: a.backend,
    skill: a.skill,
    message: msg,
    image_paths: a.images.slice(),
    history: a.skill === 'chat' ? a.history.slice(0, -1) : [],
    model: a.model || null,
    dry_run: false,
  };

  logConsole('[AGENT]: ' + a.backend + ' / ' + a.skill + ' …');
  try {
    // Use shared job runner so cancel + progress work
    var { runOpWithCancel } = await import('/js/job-control.js');
    var data = await runOpWithCancel('agent_chat', body, { label: 'Agent…' });
    if (!data || !data.ok) {
      var err = (data && data.error) || 'agent failed';
      a.history.push({ role: 'assistant', content: 'Error: ' + err });
      logConsole('[AGENT ERROR]: ' + err, 'error');
      renderAgentForm();
      return;
    }
    var text = '';
    if (data.items && data.items[0] && data.items[0].content) {
      text = data.items[0].content;
    } else if (data.stdout) {
      var pm = String(data.stdout).match(/^PROMPT:\s*(.+)$/m);
      text = pm ? pm[1].trim() : String(data.stdout).trim();
    }
    a.history.push({ role: 'assistant', content: text || '(empty)' });
    logConsole('[AGENT]: done (' + (data.command || '') + ')');
    renderAgentForm();
  } catch (err) {
    a.history.push({ role: 'assistant', content: 'Error: ' + err.message });
    logConsole('[AGENT ERROR]: ' + err.message, 'error');
    renderAgentForm();
  }
}

/** Called when Img2Img tab opens — apply pending prompt/image from Agent. */
function applyPendingToImg2Img() {
  var a = state.agent;
  if (!a) return;
  if (a._pendingI2iPrompt) {
    var el = document.getElementById('i2iPrompt');
    if (el) el.value = a._pendingI2iPrompt;
    delete a._pendingI2iPrompt;
  }
  if (a._pendingI2iImage) {
    var inp = document.getElementById('i2iInput');
    if (inp) inp.value = a._pendingI2iImage;
    delete a._pendingI2iImage;
  }
}

function applyPendingToTxt2Img() {
  var a = state.agent;
  if (!a || !a._pendingT2iPrompt) return;
  var el = document.getElementById('t2iPrompt');
  if (el) el.value = a._pendingT2iPrompt;
  delete a._pendingT2iPrompt;
}

export { renderAgentForm, applyPendingToImg2Img, applyPendingToTxt2Img };
