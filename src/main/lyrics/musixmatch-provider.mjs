/**
 * AlwaysLyrics 전용 — 동기 가사 데이터는 MusixMatch API만 사용합니다.
 */
import { z } from 'zod';
import makeCookieFetch from 'fetch-cookie';
import { hangulize } from '../hangulize/index.js';

const cookieFetch = makeCookieFetch(fetch);
const cacheTable = {};
const TRANSLATION_CACHE_MAX = 500;

const translationCache = {}; // ja -> ko 캐시 (번역 API 호출 절감)
const translationCacheOrder = []; // LRU용

const COVER_KEYWORDS = [
  '歌ってみた', '踊ってみた', '演奏してみた',
  'covered by', 'Cover by', 'Cover:', 'cover:',
  'Covered by', 'カバー', 'cover',
];

function hasCoverKeyword(title, artist) {
  const raw = [title || '', artist || ''].join(' ');
  return COVER_KEYWORDS.some((kw) => raw.includes(kw));
}

/** 【歌ってみた】로 시작하는 제목만 처리. 5가지 패턴에 맞춰 제목/원곡 아티스트 추출 */
function extractOriginalTrackRuleBased(title, artist) {
  const raw = String(title || '').trim();
  if (!raw.startsWith('【歌ってみた】')) {
    return { title: raw, artist: '' };
  }
  let s = raw.replace(/^【歌ってみた】/, '').trim();
  // 끝의 【...】 블록 제거 (예: 【レイン・パターソン/にじさんじ】, 【covered by 花宮莉歌】)
  s = s.replace(/\s*【[^】]*】\s*$/g, '').trim();
  // 끝의 " covered by X" 제거 (예: covered by 明透, covered by 幸祜&HACHI, covered by ヰ世界情緒)
  s = s.replace(/\s+covered\s+by\s+.+$/i, '').trim();
  // 끝의 공백+슬래시 제거 (예: "君の知らない物語 /" → "君の知らない物語")
  s = s.replace(/\s*[\/／\uFF0F\u2044\u2215]\s*$/g, '').trim();
  s = s.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();

  let outTitle = s;
  let outArtist = '';
  const inputArtist = typeof artist === 'string' ? artist.trim() : '';

  if (s.includes(' / ')) {
    const parts = s.split(' / ').map((p) => p.trim());
    const left = parts[0] || '';
    const right = parts[1] || '';
    if (right) {
      // right가 "covered by" 포함이거나, 트랙 아티스트가 있으면 right는 커버 아티스트로 간주
      if (/covered\s*by/i.test(right) || inputArtist) {
        outTitle = left;
        outArtist = ''; // 커버 아티스트로 판단, 비움
      } else {
        outTitle = left;
        outArtist = right;
      }
    } else {
      outTitle = left;
      outArtist = '';
    }
  } else if (s.includes(' - ')) {
    const parts = s.split(' - ').map((p) => p.trim());
    const left = parts[0] || '';
    const right = parts.slice(1).join(' - ').trim() || '';
    if (left && right) {
      outTitle = left;
      outArtist = right;
    } else {
      outTitle = left || s;
      outArtist = '';
    }
  }

  return { title: outTitle.trim(), artist: (outArtist || '').trim() };
}

/** getLyric의 cacheKey와 동일한 문자열 (재생 중 곡 ↔ 캐시 목록 매칭용) */
export function computeLyricCacheKeyForSearch(title, artist, extractOriginalTrack) {
  const useExtract = extractOriginalTrack === true;
  const shouldExtract = useExtract && String(title || '').startsWith('【歌ってみた】');
  const extracted = shouldExtract
    ? extractOriginalTrackRuleBased(title, artist)
    : { title: String(title || ''), artist: String(artist || '') };
  const searchTitle = extracted.title || title;
  const searchArtist = shouldExtract ? extracted.artist : artist;
  return [undefined, searchTitle, searchArtist].filter(Boolean).join('|');
}

const LyricResponseSchema = z.object({
  id: z.number(),
  name: z.string(),
  trackName: z.string(),
  artistName: z.string(),
  albumName: z.string(),
  duration: z.number(), // in seconds not ms
  instrumental: z.boolean().optional(),
  plainLyrics: z.string(),
  syncedLyrics: z.string().nullable(), // [mm:ss.xx] lyrics\n ...
});

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';

export class MusixMatchLyricProvider {
  constructor(_config, logger, getShowKoreanPronunciation, getExtractOriginalTrack, getUseTranslationWhenNoKorean) {
    const [config, setConfig] = _config;
    this.name = 'MusixMatch';
    this.usertoken = "";
    this._updatingUserTokenPromise = null;
    this.targetLanguage = "ko";
    this._config = _config;
    this.getShowKoreanPronunciation = typeof getShowKoreanPronunciation === 'function' ? getShowKoreanPronunciation : () => true;
    this.getExtractOriginalTrack = typeof getExtractOriginalTrack === 'function' ? getExtractOriginalTrack : () => true;
    this.getUseTranslationWhenNoKorean = typeof getUseTranslationWhenNoKorean === 'function' ? getUseTranslationWhenNoKorean : () => false;
    this.getConfig = () => ({
      showKoreanPronunciation: this.getShowKoreanPronunciation(),
      extractOriginalTrack: this.getExtractOriginalTrack(),
      useTranslationWhenNoKorean: this.getUseTranslationWhenNoKorean(),
      ...config(),
    });
    this.setConfig = setConfig;
    this.logger = logger;
  }

  /** 일본어 → 한국어 번역 (한국어 가사 없을 때). MyMemory API 사용, LRU 캐시 적용. */
  async translateJaToKo(text) {
    if (!text || typeof text !== 'string') return null;
    const key = text.trim();
    if (!key) return null;
    if (translationCache[key]) {
      const idx = translationCacheOrder.indexOf(key);
      if (idx >= 0) {
        translationCacheOrder.splice(idx, 1);
        translationCacheOrder.push(key);
      }
      return translationCache[key];
    }
    try {
      const url = `${MYMEMORY_URL}?q=${encodeURIComponent(key)}&langpair=ja|ko`;
      const res = await fetch(url);
      const json = await res.json();
      const translated = json?.responseData?.translatedText;
      if (translated) {
        if (translationCacheOrder.length >= TRANSLATION_CACHE_MAX) {
          const oldest = translationCacheOrder.shift();
          delete translationCache[oldest];
        }
        translationCache[key] = translated;
        translationCacheOrder.push(key);
        return translated;
      }
    } catch (e) {
      this.logger?.warn?.('[MusixMatch] [MusixMatch] Translation API failed', e?.message);
    }
    return null;
  }

  async getUserToken() {
    const config = this.getConfig();
    this.targetLanguage = config.language || "ko";
    this.usertoken = config.musixMatchToken
    if (this.usertoken) return this.usertoken;
    if (!this._updatingUserTokenPromise) {
      this.logger.info('[MusixMatch] [MusixMatch] Fetching user token...');
      this._updatingUserTokenPromise = this._updateUserToken();
    }
    return await this._updatingUserTokenPromise;
  }

  async _updateUserToken() {
    const res = await cookieFetch("https://apic.musixmatch.com/ws/1.1/token.get?app_id=mac-ios-v2.0")
    const json = await res.json()
    if (!json || !json.message || json.message.header.status_code !== 200) {
      throw new Error('Failed to fetch user token from MusixMatch');
    }
    this.usertoken = json.message.body.user_token;
    this.setConfig({ musixMatchToken: this.usertoken });
    return this.usertoken;
  }

  async getLyricById(id) {
    if (cacheTable[id]) {
      this.logger.info("[MusixMatch] [MusixMatch] Returning cached lyric for ID (applying current settings)", id);
      return await this.buildResultFromRaw(cacheTable[id]);
    }
    const query = new URLSearchParams();
    query.set('commontrack_id', this.encode(id));
    query.set('usertoken', this.encode(await this.getUserToken()));
    query.set('app_id', this.encode("mac-ios-v2.0"));
    this.logger.info("[MusixMatch] [MusixMatch] Fetching lyric by ID", id, query.toString());

    const response = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/macro.subtitles.get?${query.toString()}`);
    const json = await response.json();
    const success = json.message?.body?.macro_calls?.['track.lyrics.get']?.message?.header?.status_code === 200;
    if (!success) {
      this.logger.warn('[MusixMatch] [MusixMatch] Failed to fetch lyrics', json);
      return null;
    }
    const parsed = await this.musixmatchMacroToLyricScheme(json);
    if (!parsed.success) return null;

    const lyric = parsed.data[0];
    if (!lyric.syncedLyrics) return null;

    const isJaSub = json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_language === "ja";

    let translations = [];
    const translationResponse = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/crowd.track.translations.get?app_id=mac-ios-v2.0&usertoken=${this.encode(await this.getUserToken())}&commontrack_id=${this.encode(lyric.id.toString())}&selected_language=${(this.getConfig().language || this.targetLanguage)}`);
    const translationJson = await translationResponse.json();
    if (translationJson.message?.header?.status_code === 200) {
      translations = translationJson.message?.body?.translations_list || [];
    } else {
      this.logger.warn('[MusixMatch] [MusixMatch] Failed to fetch translation', translationJson);
    }

    const raw = { lyric, syncedLyrics: lyric.syncedLyrics, translations, isJaSub };
    cacheTable[id] = raw;
    scheduleLyricsCachePersist();
    return await this.buildResultFromRaw(raw);
  }

  async getLyric(params) {
    if (params.page && params.page > 1) return null;
    const title = params.title ?? params.titile ?? params.trackTitle ?? "";
    const artist = params.artist ?? params.aritist ?? params.channelName ?? "";
    const cfg = this.getConfig();
    const useExtract = cfg.extractOriginalTrack === true;
    const shouldExtract = useExtract && (title || '').startsWith('【歌ってみた】');
    const extracted = shouldExtract
      ? extractOriginalTrackRuleBased(title, artist)
      : { title, artist };
    const searchTitle = extracted.title || title;
    // 추출 시 아티스트를 비웠으면 빈 문자열 유지 (원래 artist로 대체하지 않음)
    const searchArtist = shouldExtract ? extracted.artist : artist;
    if (shouldExtract && (searchTitle !== title || searchArtist !== artist)) {
      this.logger.info("[MusixMatch] [MusixMatch] Rule-based extracted original track for search", { original: { title, artist }, extracted: { title: searchTitle, artist: searchArtist } });
    }
    const cacheKey = [params.page, searchTitle, searchArtist].filter(Boolean).join('|');
    if (!params.skipCache && cacheTable[cacheKey]) {
      this.logger.info("[MusixMatch] [MusixMatch] Returning cached lyric for params (applying current settings)", params);
      return await this.buildResultFromRaw(cacheTable[cacheKey]);
    }

    if (!String(searchTitle || '').trim() && !String(searchArtist || '').trim()) {
      this.logger.warn('[MusixMatch] [MusixMatch] Empty title and artist, skip search', params);
      return null;
    }

    const usertoken = this.encode(await this.getUserToken());
    const appId = this.encode('mac-ios-v2.0');

    const macroUrl = (extra) => {
      const q = new URLSearchParams();
      q.set('usertoken', usertoken);
      q.set('app_id', appId);
      Object.entries(extra).forEach(([k, v]) => {
        if (v == null) return;
        q.set(k, this.encode(String(v)));
      });
      return `https://apic.musixmatch.com/ws/1.1/macro.subtitles.get?${q.toString()}`;
    };

    const isLyricsOk = (json) =>
      json?.message?.body?.macro_calls?.['track.lyrics.get']?.message?.header?.status_code === 200;

    let json = null;
    const isrc = await this.getIsrc(searchTitle, searchArtist);
    if (isrc) {
      this.logger.info('[MusixMatch] [MusixMatch] Fetching lyrics by ISRC', isrc);
      const res = await cookieFetch(macroUrl({ track_isrc: isrc }));
      json = await res.json();
    }
    if (!json || !isLyricsOk(json)) {
      this.logger.info('[MusixMatch] [MusixMatch] Fallback: matcher q_track / q_artist', {
        q_track: searchTitle,
        q_artist: searchArtist,
      });
      const res = await cookieFetch(
        macroUrl({ q_track: searchTitle || '', q_artist: searchArtist || '' }),
      );
      json = await res.json();
    }
    const success = isLyricsOk(json);
    if (!success) {
      this.logger.warn('[MusixMatch] [MusixMatch] Failed to fetch lyrics (ISRC·매처 모두 실패)', json);
      return null;
    }
    let parsed = await this.musixmatchMacroToLyricScheme(json);
    if (!parsed.success) {
      this.logger.warn('[MusixMatch] [MusixMatch] Failed to parse search response', parsed.error);
      return null;
    }

    let lyric = parsed.data[0];
    this.logger.info('[MusixMatch] [MusixMatch] Fetched lyric', lyric);
    if (!lyric.syncedLyrics) {
      this.logger.info('[MusixMatch] [MusixMatch] No synced lines on ISRC result, try matcher');
      const res = await cookieFetch(
        macroUrl({ q_track: searchTitle || '', q_artist: searchArtist || '' }),
      );
      const json2 = await res.json();
      if (isLyricsOk(json2)) {
        json = json2;
        parsed = await this.musixmatchMacroToLyricScheme(json2);
        if (parsed.success) lyric = parsed.data[0];
      }
    }
    if (!lyric?.syncedLyrics) return null;
    this.logger.info('[MusixMatch] [MusixMatch] Synced lyrics found', lyric.syncedLyrics);

    const isJaSub = json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle?.subtitle_language === "ja";

    let translations = [];
    const translationResponse = await cookieFetch(`https://apic.musixmatch.com/ws/1.1/crowd.track.translations.get?app_id=mac-ios-v2.0&usertoken=${this.encode(await this.getUserToken())}&commontrack_id=${this.encode(lyric.id.toString())}&selected_language=${(this.getConfig().language || this.targetLanguage)}`);
    const translationJson = await translationResponse.json();
    if (translationJson.message?.header?.status_code === 200) {
      translations = translationJson.message?.body?.translations_list || [];
    }

    const raw = { lyric, syncedLyrics: lyric.syncedLyrics, translations, isJaSub };
    cacheTable[cacheKey] = raw;
    scheduleLyricsCachePersist();
    return await this.buildResultFromRaw(raw);
  }

  async searchLyrics(params) {
    const lyric = await this.getLyric(params);
    if (!lyric) {
      this.logger.warn('[MusixMatch] [MusixMatch] No lyrics found for search', params);
      return [];
    }
    return [lyric]
  }

  encode(str) {
    return encodeURIComponent(str).replace(/%20/g, '+');
  }

  async musixmatchMacroToLyricScheme(json) {
    const m = json.message?.body?.macro_calls?.['matcher.track.get']?.message?.body?.track;
    const sub = json.message?.body?.macro_calls?.['track.subtitles.get']?.message?.body?.subtitle_list?.[0]?.subtitle;
    const obj = {
      id: Number(m?.commontrack_id) || 0,
      name: m?.track_name ?? '',
      trackName: m?.track_name ?? '',
      artistName: m?.artist_name ?? '',
      albumName: m?.album_name ?? '',
      duration: Number(m?.track_length) || 0,
      instrumental: !!m?.instrumental,
      plainLyrics: sub?.subtitle_body || '',
      syncedLyrics: sub?.subtitle_body || '',
    };
    const parsed = LyricResponseSchema.safeParse(obj);
    if (!parsed.success) {
      return { success: false, error: parsed.error };
    }
    return { success: true, data: [parsed.data] };
  }

  async getIsrc(title, artist) {
    const term = [artist, title].filter((s) => s != null && String(s).trim()).join(' ').trim() || (title || '').trim();
    if (!term) return null;
    const query = new URLSearchParams();
    query.set('term', term);
    query.set('types', 'songs');
    query.set('limit', '3');
    /** KR만 쓰면 해외·일부 음원 ISRC가 안 나와 매처 폴백까지 가기 전에 실패하기 쉬움 */
    const storefronts = ['KR', 'US', 'JP'];
    for (const store of storefronts) {
      try {
        const response = await fetch(
          `https://www.shazam.com/services/amapi/v1/catalog/${store}/search?${query.toString()}`,
        );
        const json = await response.json();
        const song = json?.results?.songs?.data?.[0];
        const isrc = song?.attributes?.isrc;
        if (isrc) {
          this.logger.info('[MusixMatch] [MusixMatch] Found ISRC via Shazam', { store, isrc });
          return isrc;
        }
      } catch (e) {
        this.logger.warn('[MusixMatch] [MusixMatch] Shazam search failed', store, e?.message);
      }
    }
    this.logger.warn('[MusixMatch] [MusixMatch] No ISRC in Shazam (KR/US/JP)', { term });
    return null;
  }

  /** raw 캐시에서 현재 설정(한글 발음 on/off 등)을 적용해 결과 객체를 만듦. 캐시에서 반환할 때마다 호출해 이미 로드된 가사도 설정 변경이 반영되도록 함. */
  async buildResultFromRaw(raw) {
    const { lyric, syncedLyrics, translations, isJaSub } = raw;
    let convertedLyrics = this.syncedLyricsToLyric(syncedLyrics);
    const cfg = this.getConfig();
    const targetKo = (cfg.language || this.targetLanguage) === "ko";

    if (targetKo && cfg.showKoreanPronunciation && isJaSub) {
      try {
        for (const [timestamp, lines] of Object.entries(convertedLyrics)) {
          if (lines[0]) convertedLyrics[Number(timestamp)].push(await hangulize(lines[0]));
        }
      } catch (e) {
        this.logger.warn("[MusixMatch] [MusixMatch] Failed to convert Japanese to Korean pronunciation", e?.message);
      }
    }

    (translations || []).forEach(tr => {
      const source = tr.translation?.subtitle_matched_line;
      const target = tr.translation?.description;
      if (source != null && target != null) {
        Object.entries(convertedLyrics).forEach(([timestamp, lines]) => {
          if (lines.includes(source)) convertedLyrics[Number(timestamp)].push(target);
        });
      }
    });

    if (targetKo && cfg.useTranslationWhenNoKorean && isJaSub) {
      try {
        this.logger.info("[MusixMatch] [MusixMatch] Applying translation when no Korean lyrics...");
        for (const [timestamp, lines] of Object.entries(convertedLyrics)) {
          const original = lines[0];
          if (!original) continue;
          const onlyOriginalOrWithPronunciation = lines.length <= 2;
          if (onlyOriginalOrWithPronunciation) {
            const translated = await this.translateJaToKo(original);
            if (translated && !lines.includes(translated)) convertedLyrics[Number(timestamp)].push(translated);
          }
        }
      } catch (e) {
        this.logger.warn("[MusixMatch] [MusixMatch] Failed to apply translation when no Korean", e?.message);
      }
    }

    return {
      ...this.responseToMetadata(lyric),
      lyric: convertedLyrics,
      lyricRaw: syncedLyrics,
    };
  }

  responseToMetadata(lyric) {
    return {
      id: lyric.id.toString(),
      title: lyric.trackName,
      album: lyric.albumName,
      artist: lyric.artistName,
      playtime: lyric.duration * 1000,
    };
  }

  syncedLyricsToLyric(lyrics) {
    if (!lyrics || typeof lyrics !== 'string') return {};
    return lyrics.split(/\r?\n/).reduce((prev, line) => {
      const s = line.trim();
      if (!s) return prev;
      const close = s.indexOf(']');
      if (close < 1 || s[0] !== '[') return prev;
      const timePart = s.slice(1, close);
      const text = s.slice(close + 1).trim();
      const parts = timePart.split(':');
      if (parts.length < 2) return prev;
      const minute = Number(parts[0]);
      const second = Number(parts[1]);
      if (!Number.isFinite(minute) || !Number.isFinite(second)) return prev;
      const timestamp = minute * 60 * 1000 + second * 1000;
      return { ...prev, [timestamp]: [text] };
    }, {});
  }
}

let lyricsCachePersistHandler = null;
let lyricsCachePersistTimer = null;

export function hydrateLyricsCacheFromDisk(map) {
  if (!map || typeof map !== 'object') return;
  for (const k of Object.keys(map)) {
    cacheTable[k] = map[k];
  }
}

export function getLyricsCacheSnapshot() {
  return JSON.parse(JSON.stringify(cacheTable));
}

export function clearLyricsCacheInMemory() {
  for (const k of Object.keys(cacheTable)) delete cacheTable[k];
}

export function clearLyricsCacheKey(key) {
  if (key == null || key === '') return;
  delete cacheTable[key];
  scheduleLyricsCachePersist();
}

/** 수동 검색으로 채운 키를 현재 재생 곡 캐시 키에 복사할 때 사용 */
export function copyLyricsCacheKey(fromKey, toKey) {
  if (fromKey == null || toKey == null || fromKey === '' || toKey === '' || fromKey === toKey) return;
  const src = cacheTable[fromKey];
  if (!src) return;
  cacheTable[toKey] = JSON.parse(JSON.stringify(src));
  scheduleLyricsCachePersist();
}

export function getLyricsCacheEntryPreview(key) {
  const raw = cacheTable[key];
  if (!raw?.syncedLyrics) return '';
  const lines = String(raw.syncedLyrics).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(0, 10).join('\n').slice(0, 600);
}

export function setLyricsCachePersistHandler(fn) {
  lyricsCachePersistHandler = typeof fn === 'function' ? fn : null;
}

function scheduleLyricsCachePersist() {
  if (!lyricsCachePersistHandler) return;
  clearTimeout(lyricsCachePersistTimer);
  lyricsCachePersistTimer = setTimeout(() => {
    try {
      lyricsCachePersistHandler(getLyricsCacheSnapshot());
    } catch (e) {
      console.warn('[AlwaysLyrics] lyrics cache persist failed', e?.message || e);
    }
  }, 1500);
}