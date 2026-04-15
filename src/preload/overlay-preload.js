const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayApi', {
  getOverlayStyle: () => ipcRenderer.invoke('overlay:get-style'),
  onOverlayStyle: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const h = (_e, p) => {
      try {
        cb(p);
      } catch (e) {
        console.error('[AlwaysLyrics][overlay] overlay-style handler:', e);
      }
    };
    ipcRenderer.on('overlay-style', h);
    return () => ipcRenderer.removeListener('overlay-style', h);
  },
  onLyric: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('lyric-update', h);
    return () => ipcRenderer.removeListener('lyric-update', h);
  },
  onPlayback: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('playback-tick', h);
    return () => ipcRenderer.removeListener('playback-tick', h);
  },
});
