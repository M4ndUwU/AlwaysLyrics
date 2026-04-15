const fs = require('fs');
const path = require('path');
const { nativeImage } = require('electron');

/** 1×1 투명 PNG (execPath·assets 실패 시). 트레이는 16×16으로 리사이즈 */
const MIN_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Windows에서 process.execPath는 nativeImage 로드에 자주 실패합니다.
 * 순서: assets/tray.png → execPath → 내장 1×1 PNG(리사이즈)
 */
function createTrayNativeImage(appRoot) {
  const candidates = [
    path.join(appRoot, 'assets', 'tray.png'),
    path.join(appRoot, 'build', 'tray.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) {
          const s = img.getSize();
          if (s.width > 32 || s.height > 32) {
            return img.resize({ width: 16, height: 16 });
          }
          return img;
        }
      }
    } catch {
      /* next */
    }
  }
  try {
    const fromExe = nativeImage.createFromPath(process.execPath);
    if (!fromExe.isEmpty()) {
      const s = fromExe.getSize();
      if (s.width > 32 || s.height > 32) {
        return fromExe.resize({ width: 16, height: 16 });
      }
      return fromExe;
    }
  } catch {
    /* ignore */
  }
  try {
    const buf = Buffer.from(MIN_PNG_BASE64, 'base64');
    const img = nativeImage.createFromBuffer(buf);
    return img.resize({ width: 16, height: 16 });
  } catch {
    return nativeImage.createEmpty();
  }
}

module.exports = { createTrayNativeImage };
