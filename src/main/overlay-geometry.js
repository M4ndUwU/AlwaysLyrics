const { screen } = require('electron');

/** @typedef {'top-left'|'top'|'top-right'|'left'|'center'|'right'|'bottom-left'|'bottom'|'bottom-right'} OverlayAnchor */

/**
 * @param {Electron.Display} display
 * @param {object} s settings subset
 * @param {OverlayAnchor} s.overlayAnchor
 * @param {number} s.overlayWidth
 * @param {number} s.overlayHeight
 * @param {number} s.overlayMarginTop
 * @param {number} s.overlayMarginLeft
 * @param {number} s.overlayMarginRight
 * @param {number} s.overlayMarginBottom
 */
function computeOverlayBounds(display, s) {
  const wa = display.workArea || display.bounds;
  const mt = Number(s.overlayMarginTop) || 0;
  const ml = Number(s.overlayMarginLeft) || 0;
  const mr = Number(s.overlayMarginRight) || 0;
  const mb = Number(s.overlayMarginBottom) || 0;

  let W = Math.floor(Number(s.overlayWidth) || 800);
  let H = Math.floor(Number(s.overlayHeight) || 240);
  const maxW = Math.max(200, wa.width - ml - mr);
  const maxH = Math.max(120, wa.height - mt - mb);
  W = Math.min(W, maxW);
  H = Math.min(H, maxH);

  const anchor = s.overlayAnchor || 'bottom';

  let x = wa.x + ml;
  let y = wa.y + mt;

  switch (anchor) {
    case 'top-left':
      break;
    case 'top':
      x = wa.x + Math.floor((wa.width - W) / 2);
      break;
    case 'top-right':
      x = wa.x + wa.width - W - mr;
      break;
    case 'left':
      y = wa.y + Math.floor((wa.height - H) / 2);
      break;
    case 'center':
      x = wa.x + Math.floor((wa.width - W) / 2);
      y = wa.y + Math.floor((wa.height - H) / 2);
      break;
    case 'right':
      x = wa.x + wa.width - W - mr;
      y = wa.y + Math.floor((wa.height - H) / 2);
      break;
    case 'bottom-left':
      y = wa.y + wa.height - H - mb;
      break;
    case 'bottom':
      x = wa.x + Math.floor((wa.width - W) / 2);
      y = wa.y + wa.height - H - mb;
      break;
    case 'bottom-right':
      x = wa.x + wa.width - W - mr;
      y = wa.y + wa.height - H - mb;
      break;
    default:
      x = wa.x + Math.floor((wa.width - W) / 2);
      y = wa.y + wa.height - H - mb;
  }

  return { x, y, width: W, height: H };
}

/**
 * @param {number | null | undefined} displayId
 * @returns {Electron.Display}
 */
function resolveDisplay(displayId) {
  const primary = screen.getPrimaryDisplay();
  if (displayId == null || displayId === '') {
    return primary;
  }
  const id = Number(displayId);
  const list = screen.getAllDisplays();
  const found = list.find((d) => d.id === id);
  return found || primary;
}

function listDisplaysForRenderer() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    primary: d.id === primary.id,
    bounds: d.bounds,
    workArea: d.workArea,
    label: typeof d.label === 'string' && d.label.trim() ? d.label.trim() : `모니터 ${i + 1}`,
  }));
}

module.exports = { computeOverlayBounds, resolveDisplay, listDisplaysForRenderer };
