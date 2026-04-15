const rootEl = document.getElementById('overlay-root');
const titleEl = document.getElementById('overlay-title');
const timeEl = document.getElementById('overlay-time');
const artistEl = document.getElementById('overlay-artist');
const matchMetaEl = document.getElementById('overlay-match-meta');
const coverEl = document.getElementById('overlay-cover');
const linesEl = document.getElementById('lines');

let lastLyric = null;
let lastProgress = 0;
let lastDuration = 0;
let playing = false;

function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function hexToRgba(hex, alpha) {
  const h = String(hex || '#000000').replace('#', '');
  if (h.length !== 6) return `rgba(12, 14, 22, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function applyOverlayStylePayload(p) {
  if (!p || typeof p !== 'object') return;
  const head = Number(p.overlayHeadFontPx);
  const lyric = Number(p.overlayLyricFontPx);
  const headPx = Number.isFinite(head) ? Math.min(40, Math.max(10, head)) : 17;
  const lyricPx = Number.isFinite(lyric) ? Math.min(40, Math.max(10, lyric)) : 16;
  const root = document.documentElement;
  root.style.setProperty('--overlay-head-font', `${headPx}px`);
  root.style.setProperty('--overlay-lyric-font', `${lyricPx}px`);
  const bg = typeof p.overlayPanelBgColor === 'string' ? p.overlayPanelBgColor : '#0c0e16';
  const headC = typeof p.overlayHeadTextColor === 'string' ? p.overlayHeadTextColor : '#f2f2f2';
  const headBg = typeof p.overlayHeadBgColor === 'string' ? p.overlayHeadBgColor : '#1a2234';
  const lyricC = typeof p.overlayLyricTextColor === 'string' ? p.overlayLyricTextColor : '#ffffff';
  const lyricBg = typeof p.overlayLyricBgColor === 'string' ? p.overlayLyricBgColor : '#1a1f2f';
  root.style.setProperty('--overlay-bg-a', hexToRgba(bg, 0.92));
  root.style.setProperty('--overlay-bg-b', hexToRgba(bg, 0.84));
  root.style.setProperty('--overlay-head-fg', headC);
  root.style.setProperty('--overlay-head-bg', hexToRgba(headBg, 0.46));
  root.style.setProperty('--overlay-head-muted', hexToRgba(headC, 0.62));
  root.style.setProperty('--overlay-lyric-fg', lyricC);
  root.style.setProperty('--overlay-lyric-dim', hexToRgba(lyricC, 0.42));
  root.style.setProperty('--overlay-lyric-bg', hexToRgba(lyricBg, 0.38));
  root.style.setProperty('--overlay-lyric-active-bg', hexToRgba(lyricBg, 0.62));
  root.style.setProperty('--overlay-lyric-active-border', hexToRgba(lyricC, 0.35));
  const headRgbSpeed = Number(p.overlayHeadRgbSpeedSec);
  root.style.setProperty(
    '--overlay-rgb-head-speed',
    `${Number.isFinite(headRgbSpeed) ? Math.min(8, Math.max(0.4, headRgbSpeed)) : 3.2}s`
  );
  if (rootEl) {
    const fill = p.overlayFillWindowBackground !== false;
    rootEl.classList.toggle('overlay-root--fill', fill);
    rootEl.classList.toggle('overlay-rgb-head', p.overlayHeadTextRgb === true);
  }
}

function updateTimeLabel() {
  if (!timeEl) return;
  timeEl.textContent = `${formatMs(lastProgress)} / ${formatMs(lastDuration)}`;
}

function renderMatchMeta(payload) {
  if (!matchMetaEl) return;
  const tuna = payload?.metaTuna;
  const mm = payload?.metaMatch;
  if (!mm || !tuna) {
    matchMetaEl.textContent = '';
    matchMetaEl.classList.add('hidden');
    return;
  }
  const same =
    (mm.title || '') === (tuna.title || '') && (mm.artist || '') === (tuna.artist || '');
  if (same) {
    matchMetaEl.textContent = '';
    matchMetaEl.classList.add('hidden');
    return;
  }
  matchMetaEl.textContent = `검색: ${mm.title || '—'} · ${mm.artist || '—'}`;
  matchMetaEl.classList.remove('hidden');
}

function renderHeadFromPayload(payload) {
  const tuna = payload?.metaTuna;
  const m = payload?.meta;
  const cover = typeof payload?.coverUrl === 'string' ? payload.coverUrl.trim() : '';
  if (coverEl) {
    if (cover) {
      coverEl.src = cover;
      coverEl.classList.remove('hidden');
    } else {
      coverEl.removeAttribute('src');
      coverEl.classList.add('hidden');
    }
  }
  if (tuna) {
    if (titleEl) titleEl.textContent = tuna.title || '';
    if (artistEl) artistEl.textContent = tuna.artist || '';
  } else if (m) {
    if (titleEl) titleEl.textContent = m.title || '';
    if (artistEl) artistEl.textContent = m.artist || '';
  } else {
    if (titleEl) titleEl.textContent = '';
    if (artistEl) artistEl.textContent = '';
  }
  renderMatchMeta(payload);
  updateTimeLabel();
}

function renderLines(lyricObj, progressMs) {
  linesEl.innerHTML = '';
  if (!lyricObj || typeof lyricObj !== 'object') {
    return;
  }
  const times = Object.keys(lyricObj)
    .map((t) => Number(t))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  let activeIdx = -1;
  for (let i = 0; i < times.length; i += 1) {
    if (progressMs >= times[i]) activeIdx = i;
  }
  times.forEach((ts, i) => {
    const lines = lyricObj[ts] || [];
    const main = lines[0] || '';
    const row = document.createElement('div');
    row.className = 'line' + (i === activeIdx ? ' active' : ' dim');
    row.textContent = main;
    if (lines.length > 1) {
      lines.slice(1).forEach((extra) => {
        const sub = document.createElement('div');
        sub.className = 'line-extra';
        sub.textContent = extra;
        row.appendChild(sub);
      });
    }
    linesEl.appendChild(row);
  });
  if (times.length > 0 && playing && activeIdx >= 0) {
    requestAnimationFrame(() => {
      scrollActiveLineToSecondSlot();
    });
  }
}

/** 현재 줄이 스크롤 영역 안에서 위에서 두 번째 칸에 오도록 맞춤 */
function scrollActiveLineToSecondSlot() {
  const active = linesEl.querySelector('.line.active');
  if (!active || !linesEl) return;
  const all = linesEl.querySelectorAll('.line');
  if (all.length === 0) return;
  const first = all[0];
  const gap = 8;
  const lineH = first.offsetHeight + gap;
  const desired = Math.max(0, active.offsetTop - lineH);
  const maxScroll = Math.max(0, linesEl.scrollHeight - linesEl.clientHeight);
  linesEl.scrollTop = Math.min(desired, maxScroll);
}

const api = window.overlayApi;

(async function bootstrapOverlayStyle() {
  try {
    if (typeof api?.getOverlayStyle === 'function') {
      const s = await api.getOverlayStyle();
      applyOverlayStylePayload(s);
    }
  } catch {
    /* ignore */
  }
  if (typeof api?.onOverlayStyle === 'function') {
    api.onOverlayStyle((p) => applyOverlayStylePayload(p));
  }
})();

if (api?.onLyric) {
  api.onLyric((payload) => {
    lastLyric = payload?.lyric || null;
    renderHeadFromPayload(payload);
    renderLines(lastLyric, lastProgress);
  });
}
if (api?.onPlayback) {
  api.onPlayback((p) => {
    lastProgress = typeof p?.progress === 'number' ? p.progress : 0;
    lastDuration = typeof p?.duration === 'number' ? p.duration : 0;
    playing = !!p?.playing;
    updateTimeLabel();
    renderLines(lastLyric, lastProgress);
  });
}
