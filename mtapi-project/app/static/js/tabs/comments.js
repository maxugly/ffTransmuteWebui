// Reddit-Style Comments Viewer Tab Module
import { logConsole } from '/app.js?v=2';
import { escapeHtml } from '/js/utils.js';

let _activeData = null; // { title, video_id, channel, total_count, threads: [] }
let _filteredThreads = [];
let _renderedCount = 0;
const PAGE_SIZE = 50;
let _collapseAllState = false;
const _userVotes = new Map(); // cid -> +1 | -1

function _formatCompact(num) {
  if (num == null) return '0';
  const n = Number(num);
  if (isNaN(n)) return '0';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return n.toLocaleString();
}

function _formatCommentDateTime(timestamp, timeText) {
  if (!timestamp && !timeText) return { label: '', full: '' };

  let full = '';
  let dateFormatted = '';

  if (timestamp) {
    const d = new Date(timestamp * 1000);
    if (!isNaN(d.getTime())) {
      full = d.toLocaleString();
      const month = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      dateFormatted = `${month} ${time}`;
    }
  }

  if (timeText && dateFormatted) {
    return { label: `${timeText} · ${dateFormatted}`, full: `${timeText} (${full})` };
  } else if (timeText) {
    return { label: timeText, full: timeText };
  } else if (dateFormatted) {
    return { label: dateFormatted, full: full };
  }

  return { label: '', full: '' };
}

function _getEffectiveScore(c) {
  const vote = _userVotes.get(c.id) || 0;
  return (c.like_count || 0) + vote;
}

function _findComment(cid) {
  if (!_activeData || !_activeData.threads) return null;
  for (const t of _activeData.threads) {
    if (t.id === cid) return t;
    if (t.replies) {
      for (const r of t.replies) {
        if (r.id === cid) return r;
      }
    }
  }
  return null;
}

function _renderVotingHtml(c) {
  const cid = c.id || '';
  const vote = _userVotes.get(cid) || 0;
  const score = (c.like_count || 0) + vote;
  const scoreClass = vote === 1 ? 'score-up' : vote === -1 ? 'score-down' : '';
  return `
    <div class="comment-voting" data-comment-id="${escapeHtml(cid)}">
      <button type="button" class="comment-vote-btn upvote ${vote === 1 ? 'active' : ''}" data-dir="1" title="Upvote" aria-label="Upvote">▲</button>
      <span class="comment-score ${scoreClass}" title="${Number(score).toLocaleString()} points">${_formatCompact(score)}</span>
      <button type="button" class="comment-vote-btn downvote ${vote === -1 ? 'active' : ''}" data-dir="-1" title="Downvote" aria-label="Downvote">▼</button>
    </div>
  `;
}

export function renderCommentsForm() {
  const panel = document.getElementById('actionPanelForm') || document.getElementById('actionPanel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="comments-workspace" id="commentsWorkspace">
      <!-- Top Control Bar -->
      <div class="comments-top-bar">
        <div class="comments-source-group">
          <select id="commentsSourceSelect" class="comments-source-select" data-help-title="Comment Source" data-help-text="Select a downloaded video to view its comment threads.">
            <option value="">Scanning for comment files…</option>
          </select>
          <button type="button" class="comments-btn" id="btnCommentsBrowse" data-help-title="Browse File" data-help-text="Pick any .comments.json or .info.json file from disk.">
            📁 Browse
          </button>
        </div>

        <div class="comments-controls-group">
          <input type="text" id="commentsSearchInput" class="comments-search-input" placeholder="Search comments or author…" data-help-title="Search Comments" data-help-text="Filter comment threads by keyword or author username.">
          
          <select id="commentsSortSelect" class="comments-sort-select" data-help-title="Sort Order" data-help-text="Sort threads by Top (Likes), Newest First (Date ↓), or Oldest First (Date ↑).">
            <option value="top" selected>Top (Likes)</option>
            <option value="newest">Newest (Date ↓)</option>
            <option value="oldest">Oldest (Date ↑)</option>
          </select>

          <button type="button" class="comments-btn" id="btnCommentsCollapseAll" data-help-title="Collapse All" data-help-text="Collapse all visible comment threads.">
            [-] Collapse All
          </button>
          <button type="button" class="comments-btn" id="btnCommentsExpandAll" data-help-title="Expand All" data-help-text="Expand all visible comment threads.">
            [+] Expand All
          </button>

          <span class="comments-stats-pill" id="commentsStatsPill">0 comments</span>
        </div>
      </div>

      <!-- Header & Title Info -->
      <div class="comments-header-info" id="commentsHeaderInfo" hidden>
        <div class="comments-header-title-box">
          <span class="comments-video-title" id="commentsVideoTitle"></span>
          <span class="comments-channel-name" id="commentsChannelName"></span>
        </div>
        <div class="comments-ryd-badge" id="commentsRydBadge" hidden></div>
      </div>

      <!-- Reddit-Style Comments Feed -->
      <div class="comments-feed" id="commentsFeed">
        <div class="comments-empty-state">
          <div class="comments-empty-icon">💬</div>
          <div>Select a video from the dropdown above to view Reddit-style comment threads.</div>
        </div>
      </div>

      <!-- Incremental Load More -->
      <div class="comments-load-more-row" id="commentsLoadMoreRow" hidden>
        <button type="button" class="comments-load-more-btn" id="btnCommentsLoadMore">
          Load More Threads
        </button>
      </div>
    </div>
  `;

  _bindEvents();

  // Check if a specific comments path was requested
  const targetPath = window.__pendingCommentsPath || null;
  window.__pendingCommentsPath = null;
  loadCommentFiles(targetPath);
}

function _bindEvents() {
  const select = document.getElementById('commentsSourceSelect');
  if (select) {
    select.addEventListener('change', () => {
      const path = select.value;
      if (path) loadCommentsData(path);
    });
  }

  const browseBtn = document.getElementById('btnCommentsBrowse');
  if (browseBtn) {
    browseBtn.addEventListener('click', () => {
      if (typeof window.openFileBrowserModal === 'function') {
        window.openFileBrowserModal((chosenPath) => {
          if (chosenPath && (chosenPath.endsWith('.json') || chosenPath.endsWith('.info.json'))) {
            loadCommentsData(chosenPath);
          }
        }, { resolveMode: 'file', filterExts: ['.json'] });
      }
    });
  }

  const searchInput = document.getElementById('commentsSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _applyFiltersAndRender();
    });
  }

  const sortSelect = document.getElementById('commentsSortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      _applyFiltersAndRender();
    });
  }

  const collapseAllBtn = document.getElementById('btnCommentsCollapseAll');
  if (collapseAllBtn) {
    collapseAllBtn.addEventListener('click', () => {
      _collapseAllState = true;
      const threads = document.querySelectorAll('.comment-thread');
      threads.forEach(t => {
        t.classList.add('collapsed');
        const btn = t.querySelector('.comment-collapse-btn');
        if (btn) btn.textContent = '[+]';
      });
    });
  }

  const expandAllBtn = document.getElementById('btnCommentsExpandAll');
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      _collapseAllState = false;
      const threads = document.querySelectorAll('.comment-thread');
      threads.forEach(t => {
        t.classList.remove('collapsed');
        const btn = t.querySelector('.comment-collapse-btn');
        if (btn) btn.textContent = '[-]';
      });
    });
  }

  const loadMoreBtn = document.getElementById('btnCommentsLoadMore');
  if (loadMoreBtn) {
    loadMoreBtn.addEventListener('click', () => {
      _renderNextBatch();
    });
  }

  // Delegated thread collapse and voting clicks
  const feed = document.getElementById('commentsFeed');
  if (feed) {
    feed.addEventListener('click', (ev) => {
      // 1. Voting click
      const voteBtn = ev.target.closest('.comment-vote-btn');
      if (voteBtn) {
        ev.stopPropagation();
        const widget = voteBtn.closest('.comment-voting');
        if (!widget) return;
        const cid = widget.dataset.commentId;
        if (!cid) return;
        const dir = Number(voteBtn.dataset.dir);
        const current = _userVotes.get(cid) || 0;
        if (current === dir) {
          _userVotes.delete(cid);
        } else {
          _userVotes.set(cid, dir);
        }
        const newVote = _userVotes.get(cid) || 0;
        const commentObj = _findComment(cid);
        const baseLikes = commentObj ? (commentObj.like_count || 0) : 0;
        const newScore = baseLikes + newVote;

        const upBtn = widget.querySelector('.upvote');
        const downBtn = widget.querySelector('.downvote');
        const scoreEl = widget.querySelector('.comment-score');
        if (upBtn) upBtn.classList.toggle('active', newVote === 1);
        if (downBtn) downBtn.classList.toggle('active', newVote === -1);
        if (scoreEl) {
          scoreEl.textContent = _formatCompact(newScore);
          scoreEl.title = `${Number(newScore).toLocaleString()} points`;
          scoreEl.className = `comment-score ${newVote === 1 ? 'score-up' : newVote === -1 ? 'score-down' : ''}`;
        }

        const threadEl = widget.closest('.comment-thread');
        if (threadEl) {
          const summaryScore = threadEl.querySelector('.comment-collapsed-summary .summary-score');
          if (summaryScore) {
            summaryScore.textContent = `${_formatCompact(newScore)} points`;
          }
        }
        return;
      }

      // 2. Thread collapse trigger
      const collapseTrigger = ev.target.closest('.comment-collapse-btn') || ev.target.closest('.comment-collapsed-summary');
      if (collapseTrigger) {
        const thread = collapseTrigger.closest('.comment-thread');
        if (thread) {
          thread.classList.toggle('collapsed');
          const btn = thread.querySelector('.comment-collapse-btn');
          if (btn) {
            btn.textContent = thread.classList.contains('collapsed') ? '[+]' : '[-]';
          }
        }
      }
    });
  }
}

export async function loadCommentFiles(autoSelectPath = null) {
  const select = document.getElementById('commentsSourceSelect');
  if (!select) return;

  try {
    const res = await fetch('/api/comments/files');
    const data = await res.json();
    if (!data.ok || !data.files || data.files.length === 0) {
      select.innerHTML = '<option value="">No comment files found in Downloads</option>';
      return;
    }

    select.innerHTML = '';
    let selectedExists = false;

    data.files.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.path;
      const countLabel = f.comment_count ? ` (${Number(f.comment_count).toLocaleString()} comments)` : '';
      opt.textContent = `${f.title}${countLabel}`;
      if (autoSelectPath && f.path === autoSelectPath) {
        opt.selected = true;
        selectedExists = true;
      }
      select.appendChild(opt);
    });

    if (autoSelectPath && !selectedExists) {
      const opt = document.createElement('option');
      opt.value = autoSelectPath;
      opt.textContent = autoSelectPath;
      opt.selected = true;
      select.prepend(opt);
      loadCommentsData(autoSelectPath);
    } else if (select.value) {
      loadCommentsData(select.value);
    }
  } catch (err) {
    select.innerHTML = `<option value="">Error scanning files: ${err.message}</option>`;
  }
}

export async function loadCommentsData(path) {
  const feed = document.getElementById('commentsFeed');
  const header = document.getElementById('commentsHeaderInfo');
  const statsPill = document.getElementById('commentsStatsPill');
  const rydBadge = document.getElementById('commentsRydBadge');

  if (feed) {
    feed.innerHTML = `
      <div class="comments-empty-state">
        <div class="comments-empty-icon">⏳</div>
        <div>Loading and formatting comments…</div>
      </div>
    `;
  }

  if (rydBadge) {
    rydBadge.hidden = true;
    rydBadge.innerHTML = '';
  }

  try {
    const res = await fetch(`/api/comments/data?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!data.ok) {
      if (feed) {
        feed.innerHTML = `
          <div class="comments-empty-state">
            <div class="comments-empty-icon">⚠️</div>
            <div>Failed to load comments: ${escapeHtml(data.error || 'Unknown error')}</div>
          </div>
        `;
      }
      return;
    }

    _activeData = data;

    if (header) {
      header.hidden = false;
      const titleEl = document.getElementById('commentsVideoTitle');
      const channelEl = document.getElementById('commentsChannelName');
      if (titleEl) titleEl.textContent = data.title || 'Untitled';
      if (channelEl) channelEl.textContent = data.channel ? ` · ${data.channel}` : '';
    }

    if (statsPill) {
      statsPill.textContent = `${Number(data.total_count || 0).toLocaleString()} comments (${Number(data.threads_count || 0).toLocaleString()} threads)`;
    }

    if (data.video_id && rydBadge) {
      _fetchRydForComments(data.video_id, rydBadge);
    }

    logConsole(`[COMMENTS]: Loaded ${data.total_count} comments for "${data.title}"`);
    _applyFiltersAndRender();
  } catch (err) {
    if (feed) {
      feed.innerHTML = `
        <div class="comments-empty-state">
          <div class="comments-empty-icon">⚠️</div>
          <div>Error loading comments: ${escapeHtml(err.message)}</div>
        </div>
      `;
    }
  }
}

async function _fetchRydForComments(videoId, rydBadge) {
  if (!rydBadge || !videoId) return;
  try {
    const res = await fetch(`/api/comments/ryd?video_id=${encodeURIComponent(videoId)}`);
    const ryd = await res.json();
    if (!ryd.ok) return;
    if (_activeData?.video_id !== videoId) return;

    rydBadge.hidden = false;
    const likesStr = _formatCompact(ryd.likes);
    const dislikesStr = _formatCompact(ryd.dislikes);
    rydBadge.innerHTML = `
      <span class="comments-ryd-likes" title="${Number(ryd.likes).toLocaleString()} likes">👍 ${likesStr}</span>
      <span class="comments-ryd-dislikes" title="${Number(ryd.dislikes).toLocaleString()} dislikes">👎 ${dislikesStr}</span>
      <span class="comments-ryd-ratio">(${ryd.like_ratio}%)</span>
      <span class="comments-ryd-bar" title="${ryd.like_ratio}% positive">
        <span class="comments-ryd-bar-fill" style="width: ${ryd.like_ratio}%;"></span>
      </span>
    `;
    rydBadge.title = `Return YouTube Dislike: ${Number(ryd.likes).toLocaleString()} likes vs ${Number(ryd.dislikes).toLocaleString()} dislikes (${ryd.like_ratio}% rating) · ${Number(ryd.view_count || 0).toLocaleString()} views`;
  } catch (e) {
    // Ignore RYD fetch errors
  }
}

function _applyFiltersAndRender() {
  if (!_activeData || !_activeData.threads) return;

  const query = (document.getElementById('commentsSearchInput')?.value || '').trim().toLowerCase();
  const sortMode = document.getElementById('commentsSortSelect')?.value || 'top';

  let list = _activeData.threads;

  if (query) {
    list = list.filter(t => {
      const matchTop = (t.text && t.text.toLowerCase().includes(query)) ||
                       (t.author && t.author.toLowerCase().includes(query));
      if (matchTop) return true;
      if (t.replies && t.replies.length) {
        return t.replies.some(r =>
          (r.text && r.text.toLowerCase().includes(query)) ||
          (r.author && r.author.toLowerCase().includes(query))
        );
      }
      return false;
    });
  }

  // Sort
  list = [...list].sort((a, b) => {
    // Pinned comments always stay at the top in Top sort
    if (sortMode === 'top') {
      if (a.is_pinned && !b.is_pinned) return -1;
      if (!a.is_pinned && b.is_pinned) return 1;
      return _getEffectiveScore(b) - _getEffectiveScore(a);
    }
    if (sortMode === 'newest') {
      return (b.timestamp || 0) - (a.timestamp || 0);
    }
    if (sortMode === 'oldest') {
      return (a.timestamp || 0) - (b.timestamp || 0);
    }
    return 0;
  });

  _filteredThreads = list;
  _renderedCount = 0;

  const feed = document.getElementById('commentsFeed');
  if (feed) feed.innerHTML = '';

  if (_filteredThreads.length === 0) {
    if (feed) {
      feed.innerHTML = `
        <div class="comments-empty-state">
          <div class="comments-empty-icon">🔍</div>
          <div>No comments match the search query.</div>
        </div>
      `;
    }
    const loadMoreRow = document.getElementById('commentsLoadMoreRow');
    if (loadMoreRow) loadMoreRow.hidden = true;
    return;
  }

  _renderNextBatch();
}

function _renderNextBatch() {
  const feed = document.getElementById('commentsFeed');
  const loadMoreRow = document.getElementById('commentsLoadMoreRow');
  const loadMoreBtn = document.getElementById('btnCommentsLoadMore');
  if (!feed) return;

  const start = _renderedCount;
  const end = Math.min(start + PAGE_SIZE, _filteredThreads.length);
  const slice = _filteredThreads.slice(start, end);

  const fragment = document.createDocumentFragment();

  slice.forEach(t => {
    const threadEl = document.createElement('div');
    threadEl.className = 'comment-thread';
    if (_collapseAllState) threadEl.classList.add('collapsed');

    const replyCount = t.replies ? t.replies.length : 0;
    const collapseText = _collapseAllState ? '[+]' : '[-]';

    let badgesHtml = '';
    if (t.is_pinned) badgesHtml += '<span class="badge-pinned">📌 Pinned</span> ';
    if (t.is_creator) badgesHtml += '<span class="badge-op">Creator</span> ';

    const effScore = _getEffectiveScore(t);
    const scoreStr = _formatCompact(effScore);
    const tTime = _formatCommentDateTime(t.timestamp, t.time_text);

    let repliesHtml = '';
    if (replyCount > 0) {
      repliesHtml = `
        <div class="comment-replies">
          ${t.replies.map(r => {
            const rTime = _formatCommentDateTime(r.timestamp, r.time_text);
            return `
            <div class="comment-reply-item">
              <div class="comment-meta">
                <span class="comment-author">${escapeHtml(r.author || 'Anonymous')}</span>
                ${r.is_creator ? '<span class="badge-op">Creator</span>' : ''}
                ${rTime.label ? `<span class="comment-time" title="${escapeHtml(rTime.full || rTime.label)}">${escapeHtml(rTime.label)}</span>` : ''}
                ${_renderVotingHtml(r)}
              </div>
              <div class="comment-text">${escapeHtml(r.text || '')}</div>
            </div>
            `;
          }).join('')}
        </div>
      `;
    }

    threadEl.innerHTML = `
      <div class="comment-card">
        <div class="comment-meta">
          <button type="button" class="comment-collapse-btn" aria-label="Toggle thread">${collapseText}</button>
          <span class="comment-author">${escapeHtml(t.author || 'Anonymous')}</span>
          ${badgesHtml}
          ${tTime.label ? `<span class="comment-time" title="${escapeHtml(tTime.full || tTime.label)}">${escapeHtml(tTime.label)}</span>` : ''}
          <span class="comment-collapsed-summary"> · <span class="summary-score">${scoreStr} points</span> · ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'} (click to expand)</span>
          ${_renderVotingHtml(t)}
        </div>
        <div class="comment-text">${escapeHtml(t.text || '')}</div>
      </div>
      ${repliesHtml}
    `;

    fragment.appendChild(threadEl);
  });

  feed.appendChild(fragment);
  _renderedCount = end;

  if (loadMoreRow && loadMoreBtn) {
    if (_renderedCount < _filteredThreads.length) {
      loadMoreRow.hidden = false;
      loadMoreBtn.textContent = `Load More Threads (${_renderedCount} of ${Number(_filteredThreads.length).toLocaleString()})`;
    } else {
      loadMoreRow.hidden = true;
    }
  }
}

export function openCommentsForPath(path) {
  window.__pendingCommentsPath = path;
  const navItem = document.querySelector('.nav-item[data-tab="comments"]');
  if (navItem) {
    navItem.click();
  }
}
