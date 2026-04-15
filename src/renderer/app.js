function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(text) {
  return String(text ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function init() {
  const api = window.alwaysLyrics;
  if (!api?.onNowPlaying) {
    const el = $('connect-server-error');
    if (el) {
      el.textContent = 'preload 연결 실패 — 앱을 다시 시작해 주세요.';
      el.classList.remove('hidden');
    }
    return;
  }

  const idlePanel = $('idle-panel');
  const trackPanel = $('track-panel');
  const coverEl = $('cover');
  const titleEl = $('track-title');
  const artistsEl = $('track-artists');
  const progressEl = $('track-progress');
  const stateEl = $('track-state');
  const startupEl = $('startup-login');
  const lyricTabStatus = $('lyric-tab-status');
  const trackSourceWrap = $('track-source-wrap');
  const trackUrlBtn = $('track-url-btn');

  function initTabs() {
    const nav = document.querySelector('.tabs-nav');
    if (!nav) return;
    const showTab = (id) => {
      document.querySelectorAll('.tab-btn[data-tab]').forEach((b) => {
        const active = b.dataset.tab === id;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => {
        const match = p.id === `tab-${id}`;
        p.classList.toggle('is-active', match);
      });
    };
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn[data-tab]');
      if (!btn) return;
      showTab(btn.dataset.tab);
    });
  }

  /** @param {'idle'|'ok'|'loading'|'empty'|'error'|'no-provider'} state @param {string} [detail] */
  function setLyricStatusUi(state, detail) {
    if (!lyricTabStatus) return;
    if (state === 'idle' || state === 'ok') {
      lyricTabStatus.textContent = '';
      lyricTabStatus.classList.add('hidden');
      return;
    }
    const labels = {
      loading: '가사 불러오는 중…',
      empty: '동기 가사 없음',
      error: '가사 오류',
      'no-provider': 'MusixMatch 모듈 오류',
    };
    let t = labels[state] || state;
    if (detail && (state === 'empty' || state === 'error' || state === 'no-provider')) {
      t += ` — ${detail}`;
    }
    lyricTabStatus.textContent = t;
    lyricTabStatus.classList.remove('hidden');
  }

  function setServerPill(kind, text) {
    const errEl = $('connect-server-error');
    if (!errEl) return;
    if (kind === 'ok' || kind === 'warn') {
      errEl.textContent = '';
      errEl.classList.add('hidden');
      return;
    }
    if (kind === 'err') {
      errEl.textContent = text;
      errEl.classList.remove('hidden');
    }
  }

  function updateAnchorButtons(anchor) {
    document.querySelectorAll('#overlay-anchor-grid .anchor-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.anchor === anchor);
    });
  }

  /** @param {any} s */
  function applyOverlayFields(s) {
    const disp = $('overlay-display');
    if (disp) {
      disp.value = s.overlayDisplayId == null || s.overlayDisplayId === '' ? '' : String(s.overlayDisplayId);
    }
    const ow = $('overlay-width');
    const oh = $('overlay-height');
    if (ow && s.overlayWidth != null) ow.value = String(s.overlayWidth);
    if (oh && s.overlayHeight != null) oh.value = String(s.overlayHeight);
    const mt = $('overlay-mt');
    const ml = $('overlay-ml');
    const mr = $('overlay-mr');
    const mb = $('overlay-mb');
    if (mt && s.overlayMarginTop != null) mt.value = String(s.overlayMarginTop);
    if (ml && s.overlayMarginLeft != null) ml.value = String(s.overlayMarginLeft);
    if (mr && s.overlayMarginRight != null) mr.value = String(s.overlayMarginRight);
    if (mb && s.overlayMarginBottom != null) mb.value = String(s.overlayMarginBottom);
    const ohf = $('overlay-head-font');
    const olf = $('overlay-lyric-font');
    if (ohf && s.overlayHeadFontPx != null) ohf.value = String(s.overlayHeadFontPx);
    if (olf && s.overlayLyricFontPx != null) olf.value = String(s.overlayLyricFontPx);
    const fill = $('opt-overlay-fill-bg');
    if (fill) fill.checked = s.overlayFillWindowBackground !== false;
    const ho = $('overlay-hover-opacity');
    const hol = $('overlay-hover-label');
    const hop = Number(s.overlayHoverOpacity);
    if (ho && Number.isFinite(hop)) {
      ho.value = String(Math.min(1, Math.max(0.25, hop)));
      if (hol) hol.textContent = Number(ho.value).toFixed(2);
    }
    const cbg = $('overlay-color-bg');
    const ch = $('overlay-color-head');
    const chbg = $('overlay-color-head-bg');
    const cl = $('overlay-color-lyric');
    const clbg = $('overlay-color-lyric-bg');
    const rgbHead = $('overlay-rgb-head');
    const rgbHeadSpeed = $('overlay-rgb-head-speed');
    const rgbHeadSpeedLabel = $('overlay-rgb-head-speed-label');
    if (cbg && typeof s.overlayPanelBgColor === 'string') cbg.value = s.overlayPanelBgColor;
    if (ch && typeof s.overlayHeadTextColor === 'string') ch.value = s.overlayHeadTextColor;
    if (chbg && typeof s.overlayHeadBgColor === 'string') chbg.value = s.overlayHeadBgColor;
    if (cl && typeof s.overlayLyricTextColor === 'string') cl.value = s.overlayLyricTextColor;
    if (clbg && typeof s.overlayLyricBgColor === 'string') clbg.value = s.overlayLyricBgColor;
    if (rgbHead) rgbHead.checked = !!s.overlayHeadTextRgb;
    const hs = Number(s.overlayHeadRgbSpeedSec);
    if (rgbHeadSpeed && Number.isFinite(hs)) {
      rgbHeadSpeed.value = String(Math.min(8, Math.max(0.4, hs)));
      if (rgbHeadSpeedLabel) rgbHeadSpeedLabel.textContent = `${Number(rgbHeadSpeed.value).toFixed(1)}s`;
    }
    updateAnchorButtons(s.overlayAnchor || 'bottom');
  }

  async function refreshOverlayDisplaySelect() {
    const sel = $('overlay-display');
    if (!sel || typeof api.getOverlayDisplays !== 'function') return;
    let list = [];
    try {
      list = await api.getOverlayDisplays();
    } catch {
      return;
    }
    const keep = sel.value;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '주 모니터 (기본)';
    sel.appendChild(opt0);
    for (const d of list) {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d.primary ? `${d.label} (주)` : d.label;
      sel.appendChild(opt);
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  async function applySettingsToUi() {
    if (typeof api.getSettings !== 'function' || typeof api.setSettings !== 'function') return;
    try {
      const s = await api.getSettings();
      const pron = $('opt-korean-pron');
      const extract = $('opt-extract-original');
      const trans = $('opt-translation');
      const overlay = $('opt-overlay');
      const tray = $('opt-tray');
      const lang = $('opt-language');
      const token = $('musixmatch-token');
      if (pron) pron.checked = !!s.showKoreanPronunciation;
      if (extract) extract.checked = !!s.extractOriginalTrack;
      if (trans) trans.checked = !!s.useTranslationWhenNoKorean;
      if (overlay) overlay.checked = !!s.showOverlay;
      if (tray) tray.checked = !!s.minimizeToTray;
      if (lang && s.language) lang.value = s.language;
      if (token && typeof s.musixMatchToken === 'string') token.value = s.musixMatchToken;
      await refreshOverlayDisplaySelect();
      applyOverlayFields(s);
    } catch {
      /* ignore */
    }
  }

  function wireOverlayGeometry() {
    if (typeof api.setSettings !== 'function') return;
    const savePartial = (partial) => {
      api.setSettings(partial).catch(() => {});
    };
    let geomDebounce = null;

    document.querySelectorAll('#overlay-anchor-grid .anchor-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const a = btn.dataset.anchor;
        if (!a) return;
        savePartial({ overlayAnchor: a });
        updateAnchorButtons(a);
      });
    });

    $('overlay-display')?.addEventListener('change', (e) => {
      const v = /** @type {HTMLSelectElement} */ (e.target).value;
      savePartial({ overlayDisplayId: v === '' ? null : Number(v) });
    });

    const numMap = [
      ['overlay-width', 'overlayWidth'],
      ['overlay-height', 'overlayHeight'],
      ['overlay-mt', 'overlayMarginTop'],
      ['overlay-ml', 'overlayMarginLeft'],
      ['overlay-mr', 'overlayMarginRight'],
      ['overlay-mb', 'overlayMarginBottom'],
      ['overlay-head-font', 'overlayHeadFontPx'],
      ['overlay-lyric-font', 'overlayLyricFontPx'],
    ];
    for (const [id, key] of numMap) {
      const el = $(id);
      if (!el) continue;
      const commit = () => {
        const n = Number(el.value);
        if (!Number.isFinite(n)) return;
        savePartial({ [key]: Math.round(n) });
      };
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
      el.addEventListener('input', () => {
        clearTimeout(geomDebounce);
        geomDebounce = setTimeout(commit, 320);
      });
    }

    $('overlay-refresh-displays')?.addEventListener('click', async () => {
      await refreshOverlayDisplaySelect();
      try {
        const s = await api.getSettings();
        applyOverlayFields(s);
      } catch {
        /* ignore */
      }
    });

    const ho = $('overlay-hover-opacity');
    const hol = $('overlay-hover-label');
    let hoTimer = null;
    ho?.addEventListener('input', () => {
      if (hol && ho) hol.textContent = Number(ho.value).toFixed(2);
      clearTimeout(hoTimer);
      hoTimer = setTimeout(() => {
        const v = Number(ho?.value);
        if (!Number.isFinite(v)) return;
        savePartial({ overlayHoverOpacity: Math.min(1, Math.max(0.25, v)) });
      }, 200);
    });

    $('opt-overlay-fill-bg')?.addEventListener('change', (e) => {
      const c = /** @type {HTMLInputElement} */ (e.target).checked;
      savePartial({ overlayFillWindowBackground: c });
    });

    const colorMap = [
      ['overlay-color-bg', 'overlayPanelBgColor'],
      ['overlay-color-head', 'overlayHeadTextColor'],
      ['overlay-color-lyric', 'overlayLyricTextColor'],
      ['overlay-color-head-bg', 'overlayHeadBgColor'],
      ['overlay-color-lyric-bg', 'overlayLyricBgColor'],
    ];
    for (const [id, key] of colorMap) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('input', () => {
        const v = /** @type {HTMLInputElement} */ (el).value;
        if (/^#[0-9a-fA-F]{6}$/.test(v)) savePartial({ [key]: v });
      });
    }

    $('overlay-rgb-head')?.addEventListener('change', (e) => {
      const c = /** @type {HTMLInputElement} */ (e.target).checked;
      savePartial({ overlayHeadTextRgb: c });
    });

    const wireRgbSpeed = (id, labelId, key) => {
      const rangeEl = $(id);
      const labelEl = $(labelId);
      if (!rangeEl) return;
      let t = null;
      rangeEl.addEventListener('input', () => {
        if (labelEl) labelEl.textContent = `${Number(rangeEl.value).toFixed(1)}s`;
        clearTimeout(t);
        t = setTimeout(() => {
          const v = Number(rangeEl.value);
          if (!Number.isFinite(v)) return;
          savePartial({ [key]: Math.min(8, Math.max(0.4, v)) });
        }, 140);
      });
    };
    wireRgbSpeed('overlay-rgb-head-speed', 'overlay-rgb-head-speed-label', 'overlayHeadRgbSpeedSec');
  }

  function wireSettings() {
    if (typeof api.getSettings !== 'function' || typeof api.setSettings !== 'function') return;
    const pron = $('opt-korean-pron');
    const extract = $('opt-extract-original');
    const trans = $('opt-translation');
    const overlay = $('opt-overlay');
    const tray = $('opt-tray');
    const lang = $('opt-language');
    const token = $('musixmatch-token');

    const savePartial = (partial) => {
      api.setSettings(partial).catch(() => {});
    };

    if (pron) {
      pron.addEventListener('change', () => savePartial({ showKoreanPronunciation: pron.checked }));
    }
    if (extract) {
      extract.addEventListener('change', () => savePartial({ extractOriginalTrack: extract.checked }));
    }
    if (trans) {
      trans.addEventListener('change', () => savePartial({ useTranslationWhenNoKorean: trans.checked }));
    }
    if (overlay) {
      overlay.addEventListener('change', () => {
        savePartial({ showOverlay: overlay.checked });
      });
    }
    if (tray) {
      tray.addEventListener('change', () => savePartial({ minimizeToTray: tray.checked }));
    }
    if (lang) {
      lang.addEventListener('change', () => savePartial({ language: lang.value }));
    }
    if (token) {
      let t = null;
      token.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => savePartial({ musixMatchToken: token.value.trim() }), 450);
      });
      token.addEventListener('blur', () => {
        clearTimeout(t);
        savePartial({ musixMatchToken: token.value.trim() });
      });
    }
  }

  /** @param {any} payload */
  function applyPayload(payload) {
    if (payload?.meta?.server === 'stats') {
      return;
    }
    if (payload?.meta?.server === 'listening') {
      setServerPill('ok', '');
      return;
    }
    if (payload?.meta?.server === 'error') {
      const p = Number(payload.meta.port) || 1608;
      const msg =
        payload.meta.code === 'EADDRINUSE'
          ? `포트 ${p} 사용 중 — 같은 포트를 쓰는 다른 프로그램을 끄거나 포트를 바꿔 주세요`
          : `서버 오류: ${payload.meta.message || '알 수 없음'}`;
      setServerPill('err', msg);
      return;
    }

    const d = payload?.data;
    if (!d || d.type === 'idle') {
      idlePanel.classList.remove('hidden');
      trackPanel.classList.add('hidden');
      stateEl.textContent = '대기 중';
      if (trackSourceWrap) trackSourceWrap.classList.add('hidden');
      return;
    }

    idlePanel.classList.add('hidden');
    trackPanel.classList.remove('hidden');

    titleEl.textContent = d.title || '(제목 없음)';
    artistsEl.textContent =
      d.artists && d.artists.length ? d.artists.join(', ') : '(아티스트 없음)';
    progressEl.textContent = `${formatMs(d.progress)} / ${formatMs(d.duration)}`;
    stateEl.textContent = d.type === 'playing' ? '재생 중' : '일시정지';

    if (d.coverUrl) {
      coverEl.src = d.coverUrl;
      coverEl.classList.remove('hidden');
    } else {
      coverEl.removeAttribute('src');
      coverEl.classList.add('hidden');
    }

    if (trackSourceWrap && trackUrlBtn) {
      const u = typeof d.sourceUrl === 'string' ? d.sourceUrl.trim() : '';
      if (u) {
        trackUrlBtn.dataset.url = u;
        trackSourceWrap.classList.remove('hidden');
      } else {
        trackSourceWrap.classList.add('hidden');
      }
    }
  }

  /**
   * @param {any} s
   */
  function applySnapshot(s) {
    if (!s) return;
    if (s.lastListenError && !s.listeningOk) {
      applyPayload({
        meta: {
          server: 'error',
          message: s.lastListenError.message,
          code: s.lastListenError.code,
          port: s.port || 1608,
        },
      });
      return;
    }
    if (s.listeningOk) {
      applyPayload({ meta: { server: 'listening', port: s.port || 1608 } });
    }
    if (s.lastUpdate) {
      applyPayload(s.lastUpdate);
    }
  }

  let lastCacheTrackId = '';
  let lyricCurrentTimer = null;
  let offsetCommitTimer = null;

  function formatBytes(n) {
    const x = Number(n);
    if (!Number.isFinite(x) || x < 0) return '—';
    if (x < 1024) return `${Math.round(x)} B`;
    if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
    return `${(x / (1024 * 1024)).toFixed(2)} MB`;
  }

  async function refreshLyricsCacheStats() {
    const el = $('lyrics-cache-size');
    if (!el || typeof api.getLyricsCacheStats !== 'function') return;
    try {
      const st = await api.getLyricsCacheStats();
      const b = st && typeof st.bytesOnDisk === 'number' ? st.bytesOnDisk : 0;
      el.textContent = `로컬 캐시 용량: ${formatBytes(b)}`;
    } catch {
      el.textContent = '로컬 캐시 용량: —';
    }
  }

  function applyOffsetUi(ms) {
    const o = Math.min(15000, Math.max(-8000, Math.round(Number(ms) || 0)));
    const lr = $('lyric-offset-ms');
    const ll = $('lyric-offset-label');
    if (lr) lr.value = String(o);
    if (ll) ll.textContent = `${o} ms`;
  }

  function commitOffsetMs(ms) {
    if (typeof api.setLyricOffsetMs !== 'function') return;
    clearTimeout(offsetCommitTimer);
    offsetCommitTimer = setTimeout(() => {
      api.setLyricOffsetMs(Math.round(ms)).catch(() => {});
    }, 220);
  }

  function wireOffsetRange(el) {
    if (!el) return;
    el.addEventListener('input', () => {
      const v = Number(el.value);
      applyOffsetUi(v);
      commitOffsetMs(v);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const min = Number(el.min);
      const max = Number(el.max);
      const step = Number(el.step) || 50;
      let v = Number(el.value);
      v += e.key === 'ArrowRight' ? step : -step;
      v = Math.min(max, Math.max(min, v));
      el.value = String(v);
      applyOffsetUi(v);
      commitOffsetMs(v);
    });
  }

  async function refreshLyricsCurrentPanel() {
    const emptyEl = $('lyrics-current-empty');
    const bodyEl = $('lyrics-current-body');
    const lineEl = $('lyrics-current-track-line');
    const prevEl = $('lyrics-cache-preview');
    if (!emptyEl || !bodyEl || typeof api.getLyricsCacheCurrent !== 'function') return;
    try {
      const data = await api.getLyricsCacheCurrent();
      if (!data.playing) {
        emptyEl.classList.remove('hidden');
        bodyEl.classList.add('hidden');
        return;
      }
      emptyEl.classList.add('hidden');
      bodyEl.classList.remove('hidden');
      if (lineEl) {
        lineEl.textContent = `${data.tunaTitle || '—'} — ${data.tunaArtist || '—'}`;
      }
      if (prevEl) {
        const p = data.preview && String(data.preview).trim();
        if (p) {
          prevEl.textContent = p;
          prevEl.classList.remove('empty');
        } else {
          prevEl.textContent = '캐시 없음 (재생 시 자동 검색되거나 수동 검색을 사용하세요)';
          prevEl.classList.add('empty');
        }
      }
      const o = typeof data.offsetMs === 'number' ? data.offsetMs : 0;
      applyOffsetUi(o);
    } catch {
      if (prevEl) prevEl.textContent = '정보를 불러오지 못했습니다.';
    }
  }

  async function refreshLyricsCacheListPanel() {
    const emptyEl = $('lyrics-cache-list-empty');
    const bodyEl = $('lyrics-cache-list-body');
    if (!emptyEl || !bodyEl || typeof api.getLyricsCacheList !== 'function') return;
    const emptyDefault = '저장된 가사 캐시가 없습니다.';
    try {
      const data = await api.getLyricsCacheList({ limit: 200 });
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      if (!entries.length) {
        emptyEl.textContent = emptyDefault;
        emptyEl.classList.remove('hidden');
        bodyEl.classList.add('hidden');
        bodyEl.innerHTML = '';
        return;
      }
      emptyEl.textContent = emptyDefault;
      emptyEl.classList.add('hidden');
      bodyEl.classList.remove('hidden');
      const rows = entries
        .map((entry) => {
          const searchTitle = entry.searchTitle || '—';
          const searchArtist = entry.searchArtist || '—';
          const originalTitle = entry.originalTitle || '매칭된 원 제목 정보 없음';
          const originalArtist = entry.originalTitle ? entry.originalArtist || '—' : '—';
          const offsetLine = `${Math.round(Number(entry.offsetMs) || 0)} ms`;
          return `<tr class="lyrics-cache-row${entry.isCurrent ? ' is-current' : ''}">
            <td>${escapeHtml(searchTitle)}</td>
            <td>${escapeHtml(searchArtist)}</td>
            <td>${escapeHtml(originalTitle)}</td>
            <td>${escapeHtml(originalArtist)}</td>
            <td>${escapeHtml(offsetLine)}</td>
          </tr>`;
        })
        .join('');
      bodyEl.innerHTML = `<div class="lyrics-cache-table-wrap">
        <table class="lyrics-cache-table" aria-label="가사 캐시 목록">
          <thead>
            <tr>
              <th scope="col">검색 제목</th>
              <th scope="col">검색 가수</th>
              <th scope="col">원 제목</th>
              <th scope="col">원 가수</th>
              <th scope="col">오프셋</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    } catch {
      emptyEl.classList.remove('hidden');
      bodyEl.classList.add('hidden');
      bodyEl.innerHTML = '';
      emptyEl.textContent = '가사 캐시 목록을 불러오지 못했습니다.';
    }
  }

  function scheduleLyricsCurrentRefresh() {
    clearTimeout(lyricCurrentTimer);
    lyricCurrentTimer = setTimeout(() => {
      refreshLyricsCurrentPanel().catch(() => {});
      refreshLyricsCacheStats().catch(() => {});
      refreshLyricsCacheListPanel().catch(() => {});
    }, 300);
  }

  initTabs();

  if (typeof api.onLyricStatus === 'function') {
    api.onLyricStatus((p) => {
      if (!p?.state) return;
      setLyricStatusUi(p.state, p.detail);
    });
  }

  function handleNowPlaying(payload) {
    applyPayload(payload);
    if (payload?.meta) return;
    const d = payload?.data;
    if (!d || d.type === 'idle') {
      if (lastCacheTrackId !== '') {
        lastCacheTrackId = '';
        scheduleLyricsCurrentRefresh();
      }
    } else if (d.id !== lastCacheTrackId) {
      lastCacheTrackId = d.id;
      scheduleLyricsCurrentRefresh();
    }
  }

  api.onNowPlaying(handleNowPlaying);

  await applySettingsToUi();
  wireSettings();
  wireOverlayGeometry();

  $('lyrics-current-refresh')?.addEventListener('click', () => {
    refreshLyricsCurrentPanel().catch(() => {});
    refreshLyricsCacheStats().catch(() => {});
    refreshLyricsCacheListPanel().catch(() => {});
  });

  $('lyric-cache-clear-current')?.addEventListener('click', async () => {
    if (typeof api.clearLyricsCacheCurrent !== 'function') return;
    if (!window.confirm('이 곡의 로컬 가사 캐시를 지우고 다시 불러올까요?')) return;
    try {
      await api.clearLyricsCacheCurrent();
      await refreshLyricsCurrentPanel();
      await refreshLyricsCacheStats();
      await refreshLyricsCacheListPanel();
    } catch {
      /* ignore */
    }
  });

  const offRange = $('lyric-offset-ms');
  wireOffsetRange(offRange);

  function nudgeOffset(delta) {
    const el = offRange;
    if (!el) return;
    const min = Number(el.min);
    const max = Number(el.max);
    const step = Number(el.step) || 50;
    const d = delta * step;
    let v = Number(el.value) + d;
    v = Math.min(max, Math.max(min, v));
    el.value = String(v);
    applyOffsetUi(v);
    commitOffsetMs(v);
  }

  $('lyric-offset-minus')?.addEventListener('click', () => nudgeOffset(-1));
  $('lyric-offset-plus')?.addEventListener('click', () => nudgeOffset(1));
  for (const id of ['lyric-offset-minus', 'lyric-offset-plus']) {
    $(id)?.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      nudgeOffset(e.key === 'ArrowRight' ? 1 : -1);
    });
  }

  $('lyrics-cache-list-refresh')?.addEventListener('click', () => {
    refreshLyricsCacheListPanel().catch(() => {});
  });

  const prevToggle = $('lyrics-preview-toggle');
  const prevColl = $('lyrics-preview-collapsible');
  prevToggle?.addEventListener('click', () => {
    if (!prevColl) return;
    prevColl.classList.toggle('hidden');
    const expanded = !prevColl.classList.contains('hidden');
    prevToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    prevToggle.textContent = expanded ? '가사 미리보기 접기' : '가사 미리보기 펼치기';
  });

  $('manual-search-apply')?.addEventListener('click', async () => {
    if (typeof api.applyManualLyrics !== 'function') return;
    const title = ($('manual-search-title')?.value || '').trim();
    const artist = ($('manual-search-artist')?.value || '').trim();
    try {
      const r = await api.applyManualLyrics({ title, artist });
      if (r?.ok) {
        setLyricStatusUi('ok');
        await refreshLyricsCurrentPanel();
      } else {
        setLyricStatusUi('empty', r?.error || '검색 실패');
      }
    } catch {
      setLyricStatusUi('error', '요청 실패');
    }
  });

  $('credits-github')?.addEventListener('click', (e) => {
    e.preventDefault();
    const u = $('credits-github')?.getAttribute('data-url');
    if (u && api.openExternal) api.openExternal(u).catch(() => {});
  });

  refreshLyricsCurrentPanel().catch(() => {});
  refreshLyricsCacheStats().catch(() => {});
  refreshLyricsCacheListPanel().catch(() => {});

  if (trackUrlBtn && typeof api.openExternal === 'function') {
    trackUrlBtn.addEventListener('click', () => {
      const u = trackUrlBtn.dataset.url;
      if (u) api.openExternal(u).catch(() => {});
    });
  }

  if (typeof api.getTunaState === 'function') {
    try {
      const snap = await api.getTunaState();
      applySnapshot(snap);
    } catch {
      setServerPill('err', '서버 상태를 읽지 못했습니다.');
    }
  }

  if (typeof api.rendererReady === 'function') {
    await api.rendererReady();
  }

  let lastSnapJson = '';
  const pollMs = 1200;
  setInterval(async () => {
    if (typeof api.getTunaState !== 'function') return;
    try {
      const s = await api.getTunaState();
      const key = JSON.stringify({
        stats: s.stats,
        update: s.lastUpdate,
      });
      if (key === lastSnapJson) return;
      lastSnapJson = key;
      if (s.lastUpdate) applyPayload(s.lastUpdate);
    } catch {
      /* ignore */
    }
  }, pollMs);

  if (startupEl && api.getOpenAtLogin && api.setOpenAtLogin) {
    try {
      startupEl.checked = await api.getOpenAtLogin();
      startupEl.addEventListener('change', () => {
        api.setOpenAtLogin(startupEl.checked);
      });
    } catch {
      startupEl.closest('.footer-opt')?.classList.add('hidden');
    }
  }
}

init();
