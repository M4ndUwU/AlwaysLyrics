const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alwaysLyrics', {
  version: '0.2.0',
  getTunaPort: () => ipcRenderer.invoke('tuna:get-port'),
  getTunaState: () => ipcRenderer.invoke('tuna:get-state'),
  rendererReady: () => ipcRenderer.invoke('tuna:renderer-ready'),
  getOpenAtLogin: () => ipcRenderer.invoke('settings:get-open-at-login'),
  setOpenAtLogin: (open) => ipcRenderer.invoke('settings:set-open-at-login', open),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  setOverlayVisible: (vis) => ipcRenderer.invoke('overlay:set-visible', vis),
  getOverlayDisplays: () => ipcRenderer.invoke('overlay:get-displays'),
  getLyricsCacheStats: () => ipcRenderer.invoke('lyrics-cache:get-stats'),
  getLyricsCacheList: (opts) => ipcRenderer.invoke('lyrics-cache:list', opts || {}),
  getLyricsCacheCurrent: () => ipcRenderer.invoke('lyrics-cache:current'),
  clearLyricsCache: () => ipcRenderer.invoke('lyrics-cache:clear-all'),
  clearLyricsCacheCurrent: () => ipcRenderer.invoke('lyrics:clear-current-cache'),
  applyManualLyrics: (payload) => ipcRenderer.invoke('lyrics:apply-manual', payload || {}),
  setLyricOffsetMs: (ms) => ipcRenderer.invoke('lyrics:set-offset', { ms }),
  getOverlayStyle: () => ipcRenderer.invoke('overlay:get-style'),
  onNowPlaying: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch (e) {
        console.error('[AlwaysLyrics][preload] now-playing handler:', e);
      }
    };
    ipcRenderer.on('now-playing', handler);
    return () => ipcRenderer.removeListener('now-playing', handler);
  },
  onLyricUpdate: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch (e) {
        console.error('[AlwaysLyrics][preload] lyric-update handler:', e);
      }
    };
    ipcRenderer.on('lyric-update', handler);
    return () => ipcRenderer.removeListener('lyric-update', handler);
  },
  onPlaybackTick: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch (e) {
        console.error('[AlwaysLyrics][preload] playback-tick handler:', e);
      }
    };
    ipcRenderer.on('playback-tick', handler);
    return () => ipcRenderer.removeListener('playback-tick', handler);
  },
  onLyricStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, payload) => {
      try {
        callback(payload);
      } catch (e) {
        console.error('[AlwaysLyrics][preload] lyric-status handler:', e);
      }
    };
    ipcRenderer.on('lyric-status', handler);
    return () => ipcRenderer.removeListener('lyric-status', handler);
  },
});
