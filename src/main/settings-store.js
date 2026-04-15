const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT = {
  showKoreanPronunciation: true,
  extractOriginalTrack: true,
  useTranslationWhenNoKorean: false,
  showOverlay: true,
  minimizeToTray: true,
  language: 'ko',
  musixMatchToken: '',
  /** null = 주 모니터(항상 screen.getPrimaryDisplay) */
  overlayDisplayId: null,
  overlayAnchor: 'bottom',
  overlayWidth: 880,
  overlayHeight: 260,
  overlayMarginTop: 16,
  overlayMarginLeft: 24,
  overlayMarginRight: 24,
  overlayMarginBottom: 24,
  /** 오버레이 제목·가수 영역 기본 글자 크기(px) */
  overlayHeadFontPx: 17,
  /** 오버레이 동기 가사 줄 글자 크기(px) */
  overlayLyricFontPx: 16,
  /** 마우스가 오버레이 위에 있을 때 창 불투명도 (0.3~1) */
  overlayHoverOpacity: 0.78,
  /** true면 창 전체에 패널 배경, false면 가사 줄 배경만(창은 투명 느낌) */
  overlayFillWindowBackground: true,
  /** 오버레이 패널 배경 기준색 (#RRGGBB) — 그라데이션에 사용 */
  overlayPanelBgColor: '#0c0e16',
  /** 오버레이 제목·가수·시간 등 헤더 텍스트 (#RRGGBB) */
  overlayHeadTextColor: '#f2f2f2',
  /** 오버레이 제목·가수 영역 배경색 (#RRGGBB) */
  overlayHeadBgColor: '#1a2234',
  /** 오버레이 동기 가사 본문 색 (#RRGGBB) */
  overlayLyricTextColor: '#ffffff',
  /** 오버레이 동기 가사 줄 배경색 (#RRGGBB) */
  overlayLyricBgColor: '#1a1f2f',
  /** 제목·가수 텍스트 RGB 애니메이션 */
  overlayHeadTextRgb: false,
  /** 제목·가수 RGB 애니메이션 속도(초) */
  overlayHeadRgbSpeedSec: 3.2,
  /** 트랙별 동기 가사 시간 오프셋(ms). 키는 Tuna 트랙 id 문자열 */
  lyricOffsetsMsByTrackId: {},
  /** 캐시 키별 원 제목/가수/트랙/오프셋 메타 */
  lyricCacheTrackMapByKey: {},
};

let cache = { ...DEFAULT };

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = { ...DEFAULT, ...raw };
  } catch {
    cache = { ...DEFAULT };
  }
  return get();
}

function save(next) {
  cache = { ...cache, ...next };
  try {
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.error('[AlwaysLyrics] settings save failed', e);
  }
  return get();
}

function get() {
  return { ...cache };
}

module.exports = { DEFAULT, load, save, get };
