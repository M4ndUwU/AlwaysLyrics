const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  screen,
  shell,
} = require('electron');
const fs = require('fs');

/**
 * Windows에서 CPU는 낮은데 커서만 몇 초 끊기는 경우, GPU 합성·투명 창(DWM) 부담인 경우가 많음.
 * ALWAYSLYRICS_DISABLE_GPU=1 이면 하드웨어 가속을 끔(일부 환경에서 커서 끊김 완화, 대신 CPU 사용 증가 가능).
 */
if (process.env.ALWAYSLYRICS_DISABLE_GPU === '1') {
  app.disableHardwareAcceleration();
}
const path = require('path');
const { pathToFileURL } = require('url');
const { TunaHttpServer } = require('./tuna-server');
const { loadWindowBounds, saveWindowBounds } = require('./window-state');
const settingsStore = require('./settings-store');
const { createTrayNativeImage } = require('./tray-icon');
const {
  computeOverlayBounds,
  resolveDisplay,
  listDisplaysForRenderer,
} = require('./overlay-geometry');

const DEFAULT_PORT = 1608;

let mainWindow = null;
let overlayWindow = null;
let tray = null;
const tuna = new TunaHttpServer();
/** 가사 검색·동기 가사는 MusixMatch만 사용 (다른 LRCLIB 등 경로 없음) */
let musixMatchProvider = null;
let lastTrackKey = '';
/** scheduleLyricFetch가 곡 단위로만 타이머를 걸도록 (보간마다 리셋되면 500ms 타이머가 영원히 안 돎) */
let lastLyricScheduleKey = '';
let lyricTimer = null;
/** 렌더러가 늦게 뜨면 lyric IPC가 유실되므로 마지막 상태를 보관해 renderer-ready 시 재전송 */
let lastLyricStatusForRenderer = { state: 'idle' };
let lastLyricUpdateForRenderer = null;
/** @type {ReturnType<settingsStore.get>} */
let settings = settingsStore.get();
/** 오버레이 가사 카드에 표시할 현재 트랙 커버 URL */
let lastOverlayCoverUrl = '';
/** 동기 가사가 없어도 오버레이에 제목·가수·커버를 넣기 위한 Tuna 트랙 스냅샷 */
let lastPlayingTrackForOverlay = null;
/** 동적 import로 로드한 가사 캐시 API (IPC에서 사용) */
let lyricsCacheGetSnapshot = null;
let lyricsCacheClearInMemory = null;
/** 가사 모듈 로드 완료 전 IPC가 오면 대기 */
let musixmatchInitPromise = Promise.resolve();
/** @type {((title: string, artist: string, extractOriginalTrack: boolean) => string) | null} */
let computeLyricCacheKeyForSearch = null;
/** @type {((key: string) => void) | null} */
let lyricsCacheClearSingleKey = null;
/** @type {((key: string) => string) | null} */
let lyricsCachePreviewFn = null;
let lyricsCacheCopyKeyFn = null;

app.isQuitting = false;

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-bounds.json');
}

function slimNowPlayingPayload(payload) {
  if (!payload || payload.meta || !payload.data) return payload;
  const d = payload.data;
  if (d.type === 'idle') {
    return { provider: payload.provider || 'tuna-obs', data: { type: 'idle' } };
  }
  return {
    provider: payload.provider || 'tuna-obs',
    data: {
      type: d.type,
      id: d.id,
      title: d.title,
      artists: Array.isArray(d.artists) ? d.artists : [],
      progress: typeof d.progress === 'number' && Number.isFinite(d.progress) ? d.progress : 0,
      duration: typeof d.duration === 'number' && Number.isFinite(d.duration) ? d.duration : 0,
      coverUrl: typeof d.coverUrl === 'string' ? d.coverUrl : '',
      sourceUrl: typeof d.sourceUrl === 'string' ? d.sourceUrl : '',
    },
  };
}

function broadcastNowPlaying(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const toSend = payload?.meta ? payload : slimNowPlayingPayload(payload);
  try {
    mainWindow.webContents.send('now-playing', toSend);
  } catch (e) {
    console.error('[AlwaysLyrics] IPC now-playing send failed:', e?.message || e);
  }
}

function getLyricOffsetMsForCurrentTrack() {
  const d = tuna.lastUpdateData?.data;
  if (!d || d.type === 'idle' || d.id == null) return 0;
  const map = settingsStore.get().lyricOffsetsMsByTrackId || {};
  const v = Number(map[d.id]);
  if (!Number.isFinite(v)) return 0;
  return Math.min(15000, Math.max(-8000, Math.round(v)));
}

function broadcastPlaybackTick(payload) {
  const d = payload?.data;
  const progress = d && d.type !== 'idle' ? d.progress : 0;
  const duration = d && d.type !== 'idle' ? d.duration : 0;
  const playing = !!(d && d.type === 'playing');
  const offset = getLyricOffsetMsForCurrentTrack();
  const progressForLyric = Math.max(0, progress + offset);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.webContents.send('playback-tick', {
        progress: progressForLyric,
        duration,
        playing,
      });
    } catch {
      /* ignore */
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('playback-tick', { progress, duration, playing });
    } catch {
      /* ignore */
    }
  }
}

function buildOverlaySlimFromTrackOnly() {
  if (!lastPlayingTrackForOverlay) {
    return { meta: null, metaTuna: null, metaMatch: null, lyric: null, coverUrl: '' };
  }
  const t = lastPlayingTrackForOverlay.title;
  const a = lastPlayingTrackForOverlay.artist;
  return {
    meta: { title: t, artist: a, album: lastPlayingTrackForOverlay.album || '' },
    metaTuna: { title: t, artist: a },
    metaMatch: null,
    lyric: null,
    coverUrl: lastOverlayCoverUrl || '',
  };
}

function broadcastLyricUpdate(result) {
  const slim = result
    ? {
        meta: {
          title: result.title,
          artist: result.artist,
          album: result.album,
        },
        metaTuna: lastPlayingTrackForOverlay
          ? {
              title: lastPlayingTrackForOverlay.title,
              artist: lastPlayingTrackForOverlay.artist,
            }
          : null,
        metaMatch: { title: result.title, artist: result.artist },
        lyric: result.lyric,
        coverUrl: lastOverlayCoverUrl || '',
      }
    : buildOverlaySlimFromTrackOnly();
  lastLyricUpdateForRenderer = slim;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyric-update', slim);
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('lyric-update', slim);
  }
}

/** @param {{ state: string, detail?: string }} payload */
function broadcastLyricStatus(payload) {
  lastLyricStatusForRenderer = { ...payload };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('lyric-status', payload);
    } catch {
      /* ignore */
    }
  }
}

async function fetchLyricsForPlaying(d) {
  if (!d || d.type !== 'playing') {
    broadcastLyricUpdate(null);
    broadcastLyricStatus({ state: 'idle' });
    return;
  }
  if (!musixMatchProvider) {
    broadcastLyricUpdate(null);
    broadcastLyricStatus({
      state: 'no-provider',
      detail: 'MusixMatch 가사 모듈을 불러오지 못했습니다. 콘솔 로그를 확인하세요.',
    });
    return;
  }
  const title = d.title || '';
  const artist = (d.artists && d.artists[0]) || '';
  const key = `${title}\0${artist}`;
  if (key === lastTrackKey) return;
  lastTrackKey = key;
  broadcastLyricStatus({ state: 'loading' });
  try {
    const res = await musixMatchProvider.getLyric({
      title,
      artist,
      channelName: (d.artists && d.artists.join(', ')) || '',
    });
    if (res) {
      if (typeof computeLyricCacheKeyForSearch === 'function') {
        const cacheKey = computeLyricCacheKeyForSearch(
          title,
          artist,
          settingsStore.get().extractOriginalTrack === true
        );
        rememberCurrentTrackForCacheKey(cacheKey);
      }
      broadcastLyricUpdate(res);
      broadcastLyricStatus({ state: 'ok' });
    } else {
      broadcastLyricUpdate(null);
      broadcastLyricStatus({
        state: 'empty',
        detail:
          '동기 가사를 찾지 못했습니다. 제목·아티스트가 비어 있거나 MusixMatch에 없을 수 있습니다.',
      });
    }
  } catch (e) {
    console.error('[AlwaysLyrics] 가사 불러오기 실패', e?.message || e);
    broadcastLyricUpdate(null);
    broadcastLyricStatus({
      state: 'error',
      detail: e?.message || String(e),
    });
  }
}

function scheduleLyricFetch(payload) {
  const d = payload?.data;
  if (!d || d.type !== 'playing') {
    clearTimeout(lyricTimer);
    lyricTimer = null;
    lastTrackKey = '';
    lastLyricScheduleKey = '';
    broadcastLyricUpdate(null);
    broadcastLyricStatus({ state: 'idle' });
    return;
  }
  const title = d.title || '';
  const artist = (d.artists && d.artists[0]) || '';
  const scheduleKey = `${title}\0${artist}`;
  if (scheduleKey === lastLyricScheduleKey) {
    return;
  }
  clearTimeout(lyricTimer);
  lastLyricScheduleKey = scheduleKey;
  broadcastLyricUpdate(null);
  lyricTimer = setTimeout(() => fetchLyricsForPlaying(d), 500);
}

function onTunaUpdate(payload) {
  const d0 = payload?.data;
  if (d0 && d0.type !== 'idle') {
    lastOverlayCoverUrl = typeof d0.coverUrl === 'string' ? d0.coverUrl : '';
    lastPlayingTrackForOverlay = {
      title: d0.title || '',
      artist:
        Array.isArray(d0.artists) && d0.artists.length ? d0.artists.join(', ') : '',
      album: '',
    };
  } else {
    lastOverlayCoverUrl = '';
    lastPlayingTrackForOverlay = null;
  }
  broadcastNowPlaying(payload);
  broadcastPlaybackTick(payload);
  settings = settingsStore.get();
  if (!settings.showOverlay && overlayWindow && !overlayWindow.isDestroyed()) {
    stopOverlayHoverOpacityPoll();
    overlayWindow.hide();
  }
  scheduleLyricFetch(payload);
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;
  const s = settingsStore.get();
  const display = resolveDisplay(s.overlayDisplayId);
  const b = computeOverlayBounds(display, s);
  overlayWindow = new BrowserWindow({
    ...b,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.webContents.once('did-finish-load', () => {
    broadcastOverlayStyle();
  });
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));
  overlayWindow.once('ready-to-show', () => {
    settings = settingsStore.get();
    applyOverlayGeometry();
    if (settings.showOverlay) {
      overlayWindow.show();
      startOverlayHoverOpacityPoll();
    }
  });
}

function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return;
  createOverlayWindow();
}

function setOverlayVisible(show) {
  if (show) ensureOverlayWindow();
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (show) {
    applyOverlayGeometry();
    overlayWindow.show();
    broadcastOverlayStyle();
    startOverlayHoverOpacityPoll();
  } else {
    stopOverlayHoverOpacityPoll();
    overlayWindow.hide();
  }
}

function applyOverlayGeometry() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const s = settingsStore.get();
  const display = resolveDisplay(s.overlayDisplayId);
  const b = computeOverlayBounds(display, s);
  try {
    overlayWindow.setBounds(b);
  } catch (e) {
    console.error('[AlwaysLyrics] overlay setBounds failed', e?.message || e);
  }
}

function normalizeHexColor(v, fallback) {
  const t = String(v || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t;
  return fallback;
}

function parseLyricsCacheKey(key) {
  const parts = String(key || '').split('|');
  if (parts.length >= 2) {
    return {
      searchTitle: parts[parts.length - 2] || '',
      searchArtist: parts[parts.length - 1] || '',
    };
  }
  return { searchTitle: String(key || ''), searchArtist: '' };
}

function rememberCurrentTrackForCacheKey(cacheKey) {
  if (!cacheKey) return;
  const d = tuna.lastUpdateData?.data;
  if (!d || d.type === 'idle' || !d.id) return;
  const st = settingsStore.get();
  const map = { ...(st.lyricCacheTrackMapByKey || {}) };
  const offsetsByTrackId = st.lyricOffsetsMsByTrackId || {};
  const rawOffset = Number(offsetsByTrackId[d.id]);
  const offsetMs = Number.isFinite(rawOffset)
    ? Math.min(15000, Math.max(-8000, Math.round(rawOffset)))
    : 0;
  map[cacheKey] = {
    originalTitle: d.title || '',
    originalArtist: (d.artists && d.artists[0]) || '',
    trackId: d.id,
    offsetMs,
  };
  settingsStore.save({ lyricCacheTrackMapByKey: map });
}

function getOverlayStylePayload() {
  const s = settingsStore.get();
  const head = Number(s.overlayHeadFontPx);
  const lyric = Number(s.overlayLyricFontPx);
  const ho = Number(s.overlayHoverOpacity);
  const headRgbSpeed = Number(s.overlayHeadRgbSpeedSec);
  return {
    overlayHeadFontPx: Number.isFinite(head) ? Math.min(40, Math.max(10, Math.round(head))) : 17,
    overlayLyricFontPx: Number.isFinite(lyric) ? Math.min(40, Math.max(10, Math.round(lyric))) : 16,
    overlayHoverOpacity: Number.isFinite(ho) ? Math.min(1, Math.max(0.25, ho)) : 0.78,
    overlayFillWindowBackground: s.overlayFillWindowBackground !== false,
    overlayPanelBgColor: normalizeHexColor(s.overlayPanelBgColor, '#0c0e16'),
    overlayHeadTextColor: normalizeHexColor(s.overlayHeadTextColor, '#f2f2f2'),
    overlayHeadBgColor: normalizeHexColor(s.overlayHeadBgColor, '#1a2234'),
    overlayLyricTextColor: normalizeHexColor(s.overlayLyricTextColor, '#ffffff'),
    overlayLyricBgColor: normalizeHexColor(s.overlayLyricBgColor, '#1a1f2f'),
    overlayHeadTextRgb: s.overlayHeadTextRgb === true,
    overlayHeadRgbSpeedSec: Number.isFinite(headRgbSpeed)
      ? Math.min(8, Math.max(0.4, headRgbSpeed))
      : 3.2,
  };
}

function broadcastOverlayStyle() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const payload = getOverlayStylePayload();
  try {
    overlayWindow.webContents.send('overlay-style', payload);
  } catch {
    /* ignore */
  }
}

/** ignoreMouseEvents라 DOM 호버가 안 되므로 커서 위치로 오버레이 위 호버 시 창 투명도 조절 */
let overlayHoverOpacityInterval = null;
const OVERLAY_NORMAL_OPACITY = 1;

function stopOverlayHoverOpacityPoll() {
  if (overlayHoverOpacityInterval) {
    clearInterval(overlayHoverOpacityInterval);
    overlayHoverOpacityInterval = null;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try {
      overlayWindow.setOpacity(OVERLAY_NORMAL_OPACITY);
    } catch {
      /* ignore */
    }
  }
}

function startOverlayHoverOpacityPoll() {
  stopOverlayHoverOpacityPoll();
  overlayHoverOpacityInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    try {
      const pt = screen.getCursorScreenPoint();
      const b = overlayWindow.getBounds();
      const inside =
        pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
      const hoverOp = Number(settingsStore.get().overlayHoverOpacity);
      const hoverClamped = Number.isFinite(hoverOp)
        ? Math.min(1, Math.max(0.25, hoverOp))
        : 0.78;
      const target = inside ? hoverClamped : OVERLAY_NORMAL_OPACITY;
      const cur = overlayWindow.getOpacity();
      if (Math.abs(cur - target) > 0.02) {
        overlayWindow.setOpacity(target);
      }
    } catch {
      /* ignore */
    }
  }, 80);
}

function setupOverlayDisplayListeners() {
  const reapply = () => {
    if (settingsStore.get().showOverlay) applyOverlayGeometry();
  };
  screen.on('display-metrics-changed', reapply);
  screen.on('display-added', reapply);
  screen.on('display-removed', reapply);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: '창 열기',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '가사 오버레이',
      type: 'checkbox',
      checked: settingsStore.get().showOverlay,
      click: (item) => {
        settingsStore.save({ showOverlay: item.checked });
        settings = settingsStore.get();
        setOverlayVisible(item.checked);
      },
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  if (tray) return;
  const appRoot = path.join(__dirname, '..', '..');
  const img = createTrayNativeImage(appRoot);
  if (img.isEmpty()) {
    console.warn('[AlwaysLyrics] 트레이 아이콘을 만들 수 없어 트레이를 건너뜁니다.');
    return;
  }
  tray = new Tray(img);
  tray.setToolTip('AlwaysLyrics');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

function createWindow() {
  settings = settingsStore.load();
  const saved = loadWindowBounds(windowStatePath());
  const winOpts = {
    width: 720,
    height: 560,
    minWidth: 420,
    minHeight: 380,
    autoHideMenuBar: true,
    backgroundColor: '#0d0d0f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (saved) {
    winOpts.x = saved.x;
    winOpts.y = saved.y;
    winOpts.width = saved.width;
    winOpts.height = saved.height;
  }

  mainWindow = new BrowserWindow(winOpts);

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.env.ALWAYSLYRICS_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (e) => {
    settings = settingsStore.get();
    if (settings.minimizeToTray && !app.isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
    saveWindowBounds(windowStatePath(), mainWindow);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function initMusixmatch() {
  const {
    MusixMatchLyricProvider,
    hydrateLyricsCacheFromDisk,
    setLyricsCachePersistHandler,
    getLyricsCacheSnapshot,
    clearLyricsCacheInMemory,
    clearLyricsCacheKey,
    copyLyricsCacheKey,
    getLyricsCacheEntryPreview: getLyricsCacheEntryPreviewImp,
    computeLyricCacheKeyForSearch: computeKeyFn,
  } = await import(
    pathToFileURL(path.join(__dirname, 'lyrics', 'musixmatch-provider.mjs')).href
  );
  lyricsCacheGetSnapshot = getLyricsCacheSnapshot;
  lyricsCacheClearInMemory = clearLyricsCacheInMemory;
  lyricsCacheClearSingleKey = clearLyricsCacheKey;
  lyricsCachePreviewFn = getLyricsCacheEntryPreviewImp;
  lyricsCacheCopyKeyFn = copyLyricsCacheKey;
  computeLyricCacheKeyForSearch = computeKeyFn;

  const cacheFile = path.join(app.getPath('userData'), 'lyrics-cache.json');
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') hydrateLyricsCacheFromDisk(data);
  } catch {
    /* 첫 실행 또는 손상된 파일 */
  }
  setLyricsCachePersistHandler((snapshot) => {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify(snapshot), 'utf8');
    } catch (e) {
      console.error('[AlwaysLyrics] 가사 캐시 저장 실패', e);
    }
  });

  const configFn = () => ({
    ...settingsStore.get(),
    language: settingsStore.get().language || 'ko',
    musixMatchToken: settingsStore.get().musixMatchToken || '',
  });
  const setConfigFn = (partial) => {
    settingsStore.save(partial);
    settings = settingsStore.get();
  };
  musixMatchProvider = new MusixMatchLyricProvider(
    [configFn, setConfigFn],
    console,
    () => settingsStore.get().showKoreanPronunciation,
    () => settingsStore.get().extractOriginalTrack,
    () => settingsStore.get().useTranslationWhenNoKorean
  );
}

function startTunaServer() {
  tuna.removeAllListeners();
  tuna.on('update', onTunaUpdate);
  tuna.on('stats', (stats) => {
    broadcastNowPlaying({ meta: { server: 'stats', stats } });
  });
  tuna.on('listening', (port) => {
    broadcastNowPlaying({
      meta: { server: 'listening', port },
    });
  });
  tuna.on('error', (err) => {
    broadcastNowPlaying({
      meta: {
        server: 'error',
        message: err?.message || String(err),
        code: err?.code,
        port: DEFAULT_PORT,
      },
    });
  });
  tuna.start({ port: DEFAULT_PORT, interpolationTime: 100 });
}

app.whenReady().then(async () => {
  settings = settingsStore.load();

  if (process.platform === 'win32' || process.platform === 'linux') {
    Menu.setApplicationMenu(null);
  }

  ipcMain.handle('tuna:get-port', () => DEFAULT_PORT);
  ipcMain.handle('tuna:get-state', () => tuna.getStateSnapshot());
  ipcMain.handle('tuna:renderer-ready', () => {
    if (tuna.listeningOk) {
      broadcastNowPlaying({ meta: { server: 'listening', port: DEFAULT_PORT } });
      if (tuna.lastUpdateData) broadcastNowPlaying(tuna.lastUpdateData);
    } else if (tuna.lastListenError) {
      broadcastNowPlaying({
        meta: {
          server: 'error',
          message: tuna.lastListenError.message,
          code: tuna.lastListenError.code,
          port: DEFAULT_PORT,
        },
      });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('lyric-status', lastLyricStatusForRenderer);
        if (lastLyricUpdateForRenderer) {
          mainWindow.webContents.send('lyric-update', lastLyricUpdateForRenderer);
        }
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  });

  ipcMain.handle('overlay:get-displays', () => listDisplaysForRenderer());

  ipcMain.handle('overlay:get-style', () => getOverlayStylePayload());

  ipcMain.handle('shell:open-external', async (_e, url) => {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) return { ok: false };
    await shell.openExternal(u);
    return { ok: true };
  });

  ipcMain.handle('settings:get', () => settingsStore.get());
  ipcMain.handle('settings:set', (_e, partial) => {
    settingsStore.save(partial || {});
    settings = settingsStore.get();
    setOverlayVisible(settings.showOverlay);
    const overlayGeomKeys = [
      'overlayDisplayId',
      'overlayAnchor',
      'overlayWidth',
      'overlayHeight',
      'overlayMarginTop',
      'overlayMarginLeft',
      'overlayMarginRight',
      'overlayMarginBottom',
    ];
    if (partial && overlayGeomKeys.some((k) => Object.prototype.hasOwnProperty.call(partial, k))) {
      applyOverlayGeometry();
    }
    const overlayStyleKeys = [
      'overlayHeadFontPx',
      'overlayLyricFontPx',
      'overlayHoverOpacity',
      'overlayFillWindowBackground',
      'overlayPanelBgColor',
      'overlayHeadTextColor',
      'overlayHeadBgColor',
      'overlayLyricTextColor',
      'overlayLyricBgColor',
      'overlayHeadTextRgb',
      'overlayHeadRgbSpeedSec',
    ];
    if (partial && overlayStyleKeys.some((k) => Object.prototype.hasOwnProperty.call(partial, k))) {
      broadcastOverlayStyle();
    }
    if (tray) {
      try {
        tray.setContextMenu(buildTrayMenu());
      } catch {
        /* ignore */
      }
    }
    const lyricKeys = [
      'showKoreanPronunciation',
      'extractOriginalTrack',
      'useTranslationWhenNoKorean',
      'language',
      'musixMatchToken',
    ];
    if (partial && lyricKeys.some((k) => Object.prototype.hasOwnProperty.call(partial, k))) {
      lastTrackKey = '';
      lastLyricScheduleKey = '';
      if (tuna.lastUpdateData) scheduleLyricFetch(tuna.lastUpdateData);
    }
    return settings;
  });

  ipcMain.handle('lyrics-cache:get-stats', async () => {
    await musixmatchInitPromise;
    let bytesOnDisk = 0;
    try {
      const p = path.join(app.getPath('userData'), 'lyrics-cache.json');
      const st = fs.statSync(p);
      bytesOnDisk = typeof st.size === 'number' ? st.size : 0;
    } catch {
      bytesOnDisk = 0;
    }
    if (typeof lyricsCacheGetSnapshot !== 'function') {
      return { count: 0, sampleKeys: [], bytesOnDisk };
    }
    try {
      const snap = lyricsCacheGetSnapshot();
      const keys = Object.keys(snap || {});
      return { count: keys.length, sampleKeys: keys.slice(0, 80), bytesOnDisk };
    } catch {
      return { count: 0, sampleKeys: [], bytesOnDisk };
    }
  });

  ipcMain.handle('lyrics-cache:list', async (_e, opts) => {
    await musixmatchInitPromise;
    const qRaw = opts && typeof opts.q === 'string' ? opts.q.trim().toLowerCase() : '';
    const limit = Math.min(2000, Math.max(50, Number(opts?.limit) || 800));
    if (typeof lyricsCacheGetSnapshot !== 'function') {
      return { count: 0, currentKey: null, keys: [] };
    }
    try {
      const snap = lyricsCacheGetSnapshot();
      const allKeys = Object.keys(snap || {});
      let keys = [...allKeys];
      let currentKey = null;
      const tu = tuna.getStateSnapshot();
      const d = tu.lastUpdate?.data;
      if (d && d.type !== 'idle' && typeof computeLyricCacheKeyForSearch === 'function') {
        currentKey = computeLyricCacheKeyForSearch(
          d.title || '',
          (d.artists && d.artists[0]) || '',
          settingsStore.get().extractOriginalTrack === true
        );
      }
      if (qRaw) {
        keys = keys.filter((k) => String(k).toLowerCase().includes(qRaw));
      }
      keys.sort((a, b) => String(a).localeCompare(String(b), 'ko'));
      if (currentKey && keys.includes(currentKey)) {
        keys = keys.filter((k) => k !== currentKey);
        keys.unshift(currentKey);
      }
      const totalFiltered = keys.length;
      const sliced = keys.slice(0, limit);
      const cacheTrackMap = settingsStore.get().lyricCacheTrackMapByKey || {};
      const currentTrack = d && d.type !== 'idle'
        ? {
            title: d.title || '',
            artist: (d.artists && d.artists[0]) || '',
            trackId: d.id || '',
          }
        : null;
      const entries = sliced.map((key) => {
        const parsed = parseLyricsCacheKey(key);
        const isCurrent = Boolean(currentKey && key === currentKey);
        const mapped = cacheTrackMap[key] || {};
        let originalTitle = mapped.originalTitle || '';
        let originalArtist = mapped.originalArtist || '';
        let offsetMs = Math.min(15000, Math.max(-8000, Math.round(Number(mapped.offsetMs) || 0)));
        if (isCurrent && currentTrack && (!originalTitle || !originalArtist)) {
          originalTitle = currentTrack.title;
          originalArtist = currentTrack.artist;
        }
        return {
          key,
          isCurrent,
          searchTitle: parsed.searchTitle,
          searchArtist: parsed.searchArtist,
          originalTitle,
          originalArtist,
          offsetMs,
        };
      });
      return { count: allKeys.length, totalFiltered, currentKey, keys: sliced, entries };
    } catch {
      return { count: 0, totalFiltered: 0, currentKey: null, keys: [], entries: [] };
    }
  });

  ipcMain.handle('lyrics-cache:clear-all', async () => {
    await musixmatchInitPromise;
    if (typeof lyricsCacheClearInMemory === 'function') {
      try {
        lyricsCacheClearInMemory();
      } catch (e) {
        console.error('[AlwaysLyrics] 가사 캐시 비우기 실패', e);
      }
    }
    try {
      fs.unlinkSync(path.join(app.getPath('userData'), 'lyrics-cache.json'));
    } catch {
      /* 없음 */
    }
    lastTrackKey = '';
    lastLyricScheduleKey = '';
    settingsStore.save({ lyricCacheTrackMapByKey: {} });
    const snap = tuna.getStateSnapshot();
    if (snap.lastUpdate) scheduleLyricFetch(snap.lastUpdate);
    return { ok: true };
  });

  ipcMain.handle('lyrics-cache:current', async () => {
    await musixmatchInitPromise;
    const tu = tuna.getStateSnapshot();
    const d = tu.lastUpdate?.data;
    if (!d || d.type === 'idle') {
      return { playing: false };
    }
    const extract = settingsStore.get().extractOriginalTrack === true;
    const key =
      typeof computeLyricCacheKeyForSearch === 'function'
        ? computeLyricCacheKeyForSearch(
            d.title || '',
            (d.artists && d.artists[0]) || '',
            extract
          )
        : '';
    const map = settingsStore.get().lyricOffsetsMsByTrackId || {};
    const offsetMs = Math.min(15000, Math.max(-8000, Number(map[d.id]) || 0));
    let preview = '';
    if (key && typeof lyricsCachePreviewFn === 'function') {
      try {
        preview = lyricsCachePreviewFn(key);
      } catch {
        preview = '';
      }
    }
    const hasCache = Boolean(key && preview);
    return {
      playing: true,
      trackId: d.id,
      cacheKey: key,
      preview,
      hasCache,
      offsetMs,
      tunaTitle: d.title || '',
      tunaArtist: Array.isArray(d.artists) ? d.artists.join(', ') : '',
    };
  });

  ipcMain.handle('lyrics:clear-current-cache', async () => {
    await musixmatchInitPromise;
    const d = tuna.lastUpdateData?.data;
    if (!d || d.type === 'idle') return { ok: false };
    const extract = settingsStore.get().extractOriginalTrack === true;
    if (typeof computeLyricCacheKeyForSearch !== 'function') return { ok: false };
    const key = computeLyricCacheKeyForSearch(
      d.title || '',
      (d.artists && d.artists[0]) || '',
      extract
    );
    if (typeof lyricsCacheClearSingleKey === 'function') {
      try {
        lyricsCacheClearSingleKey(key);
        const mapByKey = { ...(settingsStore.get().lyricCacheTrackMapByKey || {}) };
        if (Object.prototype.hasOwnProperty.call(mapByKey, key)) {
          delete mapByKey[key];
          settingsStore.save({ lyricCacheTrackMapByKey: mapByKey });
        }
      } catch (e) {
        console.error('[AlwaysLyrics] 캐시 항목 삭제 실패', e);
      }
    }
    lastTrackKey = '';
    lastLyricScheduleKey = '';
    if (tuna.lastUpdateData) scheduleLyricFetch(tuna.lastUpdateData);
    return { ok: true };
  });

  ipcMain.handle('lyrics:apply-manual', async (_e, payload) => {
    await musixmatchInitPromise;
    if (!musixMatchProvider) return { ok: false, error: 'no-provider' };
    const t = String(payload?.title || '').trim();
    const a = String(payload?.artist || '').trim();
    if (!t && !a) return { ok: false, error: 'empty' };
    try {
      const res = await musixMatchProvider.getLyric({
        title: t,
        artist: a,
        channelName: a,
        skipCache: true,
      });
      if (res) {
        const extract = settingsStore.get().extractOriginalTrack === true;
        const fromKey = computeLyricCacheKeyForSearch(t, a, extract);
        const cur = tuna.lastUpdateData?.data;
        if (
          cur &&
          cur.type !== 'idle' &&
          typeof computeLyricCacheKeyForSearch === 'function' &&
          typeof lyricsCacheCopyKeyFn === 'function'
        ) {
          const toKey = computeLyricCacheKeyForSearch(
            cur.title || '',
            (cur.artists && cur.artists[0]) || '',
            extract
          );
          if (fromKey && toKey && fromKey !== toKey) {
            try {
              lyricsCacheCopyKeyFn(fromKey, toKey);
              rememberCurrentTrackForCacheKey(toKey);
            } catch (e) {
              console.warn('[AlwaysLyrics] 수동 가사 캐시 복사 실패', e?.message || e);
            }
          }
        }
        if (fromKey) rememberCurrentTrackForCacheKey(fromKey);
        broadcastLyricUpdate(res);
        broadcastLyricStatus({ state: 'ok' });
        return { ok: true };
      }
      broadcastLyricUpdate(null);
      broadcastLyricStatus({
        state: 'empty',
        detail: '동기 가사를 찾지 못했습니다.',
      });
      return { ok: false };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('lyrics:set-offset', (_e, payload) => {
    const raw = payload && payload.ms != null ? payload.ms : payload;
    const ms = Number(raw);
    const d = tuna.lastUpdateData?.data;
    if (!d || !d.id) return { ok: false };
    const v = Math.min(15000, Math.max(-8000, Math.round(Number.isFinite(ms) ? ms : 0)));
    const next = { ...(settingsStore.get().lyricOffsetsMsByTrackId || {}) };
    if (v === 0) delete next[d.id];
    else next[d.id] = v;
    const mapByKey = { ...(settingsStore.get().lyricCacheTrackMapByKey || {}) };
    Object.keys(mapByKey).forEach((k) => {
      if (mapByKey[k]?.trackId === d.id) {
        mapByKey[k] = { ...mapByKey[k], offsetMs: v };
      }
    });
    settingsStore.save({ lyricOffsetsMsByTrackId: next, lyricCacheTrackMapByKey: mapByKey });
    settings = settingsStore.get();
    if (tuna.lastUpdateData) broadcastPlaybackTick(tuna.lastUpdateData);
    return { ok: true, offsetMs: v };
  });

  ipcMain.handle('settings:get-open-at-login', () => app.getLoginItemSettings().openAtLogin);
  ipcMain.handle('settings:set-open-at-login', (_e, open) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(open) });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('overlay:set-visible', (_e, vis) => {
    settingsStore.save({ showOverlay: Boolean(vis) });
    settings = settingsStore.get();
    setOverlayVisible(Boolean(vis));
    if (tray) {
      try {
        tray.setContextMenu(buildTrayMenu());
      } catch {
        /* ignore */
      }
    }
    return settingsStore.get().showOverlay;
  });

  startTunaServer();

  createWindow();

  /** 모니터 변경은 가벼움 — 오버레이 창보다 먼저 등록해 두어도 무방 */
  setupOverlayDisplayListeners();

  /** MusixMatch(zod·fetch·hangulize wasm 등)는 첫 창이 뜬 뒤 비동기로 로드해 첫 프레임 지연을 줄임 */
  setImmediate(() => {
    musixmatchInitPromise = initMusixmatch().catch((e) => {
      console.error('[AlwaysLyrics] MusixMatch 초기화 실패', e);
    });
  });

  /** 트레이는 메인 창·Chromium이 먼저 안정된 뒤(짧은 지연) */
  setTimeout(() => {
    createTray();
  }, 500);

  /**
   * 투명 오버레이는 두 번째 GPU 컨텍스트·DWM 합성 부담이 커서, 첫 실행 시 커서만 끊기는 증상과 겹치기 쉬움.
   * 메인 창이 먼저 그려진 뒤(2.8s) 생성 — 가사는 그 전에도 메인·IPC로만 동작.
   */
  setTimeout(() => {
    if (settingsStore.get().showOverlay) ensureOverlayWindow();
  }, 2800);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  app.isQuitting = true;
  tuna.close();
  stopOverlayHoverOpacityPoll();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  settings = settingsStore.get();
  if (settings.minimizeToTray && tray) {
    return;
  }
  app.quit();
});
