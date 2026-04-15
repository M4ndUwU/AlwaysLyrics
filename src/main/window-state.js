const fs = require('fs');
const path = require('path');
const { screen } = require('electron');

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 저장된 창 좌표가 현재 연결된 디스플레이 중 하나와 겹치지 않으면(모니터 분리 등) primary 작업 영역 안으로 옮김.
 */
function ensureBoundsOnScreen(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  let { x, y, width, height } = bounds;
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  width = Math.max(200, Math.min(width, 4096));
  height = Math.max(200, Math.min(height, 4096));

  const displays = screen.getAllDisplays();
  const intersects = (b, wa) =>
    b.x + b.width > wa.x &&
    b.x < wa.x + wa.width &&
    b.y + b.height > wa.y &&
    b.y < wa.y + wa.height;

  const candidate = { x, y, width, height };
  for (const d of displays) {
    if (intersects(candidate, d.workArea)) return candidate;
  }

  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  return {
    width: Math.min(width, wa.width - 32),
    height: Math.min(height, wa.height - 32),
    x: wa.x + Math.floor((wa.width - Math.min(width, wa.width - 32)) / 2),
    y: wa.y + Math.floor((wa.height - Math.min(height, wa.height - 32)) / 2),
  };
}

function loadWindowBounds(statePath) {
  const raw = readJsonSafe(statePath);
  if (!raw || typeof raw !== 'object') return null;
  return ensureBoundsOnScreen(raw);
}

function saveWindowBounds(statePath, win) {
  try {
    const b = win.getBounds();
    fs.writeFileSync(statePath, JSON.stringify(b, null, 0), 'utf8');
  } catch {
    /* ignore */
  }
}

module.exports = { loadWindowBounds, saveWindowBounds, ensureBoundsOnScreen };
