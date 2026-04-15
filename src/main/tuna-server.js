const http = require('http');
const { EventEmitter } = require('events');

const DEBUG = process.env.ALWAYSLYRICS_DEBUG === '1';

function requestPathname(req) {
  const raw = req.url || '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

function normalizeStatus(status) {
  if (typeof status !== 'string') return status;
  const s = status.toLowerCase();
  if (s === 'playing' || s === 'paused' || s === 'idle') return s;
  return status;
}

/**
 * Tuna/YouTube Music 일부 소스는 title을 비우고 alternativeTitle·tags만 보냅니다.
 * 표시·MusixMatch 검색에 쓸 제목을 한 줄로 정리합니다.
 * @param {Record<string, unknown>} data body.data
 */
function resolveTrackTitle(data) {
  const direct = String(data.title ?? '').trim();
  if (direct) return direct;
  const alt = String(data.alternativeTitle ?? '').trim();
  if (alt) return alt;

  let artists = [];
  if (Array.isArray(data.artists)) artists = data.artists;
  else if (typeof data.artists === 'string' && data.artists.trim()) artists = [data.artists.trim()];
  const artistSet = new Set(artists.map((a) => String(a).trim().toLowerCase()).filter(Boolean));

  if (Array.isArray(data.tags)) {
    for (const tag of data.tags) {
      const s = String(tag ?? '').trim();
      if (!s) continue;
      if (artistSet.has(s.toLowerCase())) continue;
      return s;
    }
  }
  return '';
}

/**
 * tuna-obs / Tuna 플러그인에서 쓰는 JSON 계약과 맞춥니다.
 * POST http://127.0.0.1:<port>/
 * 사용 필드: status, progress, duration, artists, cover_url|cover, title, alternativeTitle?, tags?, url?, lyrics?
 * (album_url 등은 커버와 중복되는 경우가 많아 표시·검색에는 쓰지 않음)
 *
 * 일부 클라이언트는 `/`가 아닌 경로로 보낼 수 있어, 본문이 Tuna 형식이면 경로와 무관하게 처리합니다.
 */
class TunaHttpServer extends EventEmitter {
  constructor() {
    super();
    this.port = 1608;
    this.server = null;
    this.listeningOk = false;
    this.lastListenError = null;
    this.lastUpdateData = null;
    this.interpolationTime = 100;
    this.interpolation = null;

    /** 연속 POST에서 progress가 같으면(플레이어는 멈췄는데 Tuna가 playing만 보내는 경우) 일시정지로 간주 */
    this.lastTunaPostProgress = null;
    this.sameProgressPostStreak = 0;

    /** 디버깅·UI 표시용 */
    this.stats = {
      httpHits: 0,
      postAttempts: 0,
      validTunaPosts: 0,
      lastHttpAt: null,
      lastPath: null,
      lastReject: null,
    };
  }

  bumpHttp(method, pathname) {
    this.stats.httpHits += 1;
    this.stats.lastHttpAt = new Date().toISOString();
    this.stats.lastPath = `${method} ${pathname}`;
  }

  emitStatsToRenderer() {
    this.emit('stats', { ...this.stats });
  }

  start(options = {}) {
    this.lastListenError = null;
    this.listeningOk = false;
    const port = Number(options.port);
    this.port = Number.isFinite(port) && port > 0 ? port : 1608;
    this.interpolationTime = Number(options.interpolationTime);
    if (!Number.isFinite(this.interpolationTime) || this.interpolationTime < 1) {
      this.interpolationTime = 100;
    }

    if (this.server) this.close();

    this.server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      const pathname = requestPathname(req);

      if (req.method === 'OPTIONS') {
        this.bumpHttp('OPTIONS', pathname);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
        this.bumpHttp('GET', pathname);
        this.emitStatsToRenderer();
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
      }

      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          this.stats.postAttempts += 1;
          this.bumpHttp('POST', pathname);
          const rawStr = Buffer.concat(chunks).toString('utf8');
          const result = this.processTunaPost(rawStr, pathname);
          if (result.handled) {
            res.writeHead(result.status);
            res.end(result.body);
          } else {
            if (DEBUG) console.warn('[AlwaysLyrics][tuna] 404', req.method, req.url);
            res.writeHead(404);
            res.end();
          }
        });
        return;
      }

      this.bumpHttp(req.method || '?', pathname);
      if (DEBUG) console.warn('[AlwaysLyrics][tuna] 404', req.method, req.url);
      res.writeHead(404);
      res.end();
    });

    this.server.on('error', (err) => {
      this.listeningOk = false;
      this.lastListenError = err;
      if (this.server) {
        try {
          this.server.close();
        } catch {
          /* ignore */
        }
        this.server = null;
      }
      this.emit('error', err);
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      this.listeningOk = true;
      this.lastListenError = null;
      this.emit('listening', this.port);
      this.emitStatsToRenderer();
    });

    this.setupInterpolation();
  }

  /**
   * @returns {{ handled: boolean, status?: number, headers?: Record<string, string>, body?: string }}
   */
  processTunaPost(rawStr, pathname) {
    let body;
    try {
      body = rawStr ? JSON.parse(rawStr) : null;
    } catch (e) {
      this.stats.lastReject = `JSON: ${e.message}`;
      this.emitStatsToRenderer();
      if (DEBUG) console.warn('[AlwaysLyrics][tuna] JSON parse', e.message, rawStr.slice(0, 200));
      return { handled: true, status: 401, body: 'invalid json' };
    }

    if (body?.data && typeof body.data === 'object' && body.data.status != null) {
      body.data.status = normalizeStatus(body.data.status);
    }

    const check = this.validateBody(body);
    if (!check.ok) {
      this.stats.lastReject = check.error || 'invalid data';
      this.emitStatsToRenderer();
      if (DEBUG) console.warn('[AlwaysLyrics][tuna] validate fail', pathname, this.stats.lastReject, JSON.stringify(body).slice(0, 400));
      return { handled: true, status: 401, body: check.error || 'invalid data' };
    }

    if (pathname !== '/' && pathname !== '') {
      if (DEBUG) console.warn('[AlwaysLyrics][tuna] POST accepted on non-root path (Tuna 본문 인식):', pathname);
    }

    this.stats.validTunaPosts += 1;
    this.stats.lastReject = null;
    this.lastUpdateData = this.convertData(body);
    const d = this.lastUpdateData.data;
    if (d.type === 'playing') {
      const prog = d.progress;
      if (this.lastTunaPostProgress !== null && prog === this.lastTunaPostProgress) {
        this.sameProgressPostStreak += 1;
      } else {
        this.sameProgressPostStreak = 1;
      }
      this.lastTunaPostProgress = prog;
      if (this.sameProgressPostStreak >= 2 && prog > 0) {
        d.type = 'paused';
      }
    } else if (d.type !== 'idle') {
      this.lastTunaPostProgress = d.progress;
      this.sameProgressPostStreak = 0;
    } else {
      this.lastTunaPostProgress = null;
      this.sameProgressPostStreak = 0;
    }
    this.emit('update', this.lastUpdateData);
    this.emitStatsToRenderer();
    return { handled: true, status: 200, body: 'success' };
  }

  validateBody(body) {
    if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object') {
      return { ok: false, error: 'invalid data' };
    }
    const { status } = body.data;
    if (status !== 'playing' && status !== 'paused' && status !== 'idle') {
      return { ok: false, error: 'invalid data' };
    }
    return { ok: true };
  }

  convertData(body) {
    const data = body.data;
    const result = {
      data: { type: 'idle' },
      provider: 'tuna-obs',
    };

    if (data.status === 'playing' || data.status === 'paused') {
      const coverUrl = data.cover_url ?? data.cover ?? '';
      const resolvedTitle = resolveTrackTitle(data);
      const id = `${resolvedTitle}:${coverUrl}`;
      const lastLyric =
        this.lastUpdateData?.data?.type !== 'idle' &&
        this.lastUpdateData?.data?.id === id
          ? this.lastUpdateData.data.playerLyrics
          : undefined;

      let artists = [];
      if (Array.isArray(data.artists)) artists = data.artists;
      else if (typeof data.artists === 'string' && data.artists.trim()) artists = [data.artists.trim()];

      const progress = Number(data.progress);
      const duration = Number(data.duration);

      const sourceUrl = typeof data.url === 'string' ? data.url.trim() : '';

      result.data = {
        type: data.status,
        id,
        title: resolvedTitle,
        artists,
        progress: Number.isFinite(progress) ? progress : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        coverUrl,
        sourceUrl,
        playerLyrics: data.lyrics ?? lastLyric,
      };
    }

    return result;
  }

  setupInterpolation() {
    if (this.interpolation) clearInterval(this.interpolation);
    this.interpolation = setInterval(() => {
      if (!this.lastUpdateData) return;
      if (this.lastUpdateData.data.type !== 'playing') return;

      const d = this.lastUpdateData.data;
      if (d.duration - d.progress < this.interpolationTime) {
        d.progress = d.duration;
      } else {
        d.progress += this.interpolationTime;
      }

      this.emit('update', this.lastUpdateData);
    }, this.interpolationTime);
  }

  close() {
    this.listeningOk = false;
    if (this.interpolation) {
      clearInterval(this.interpolation);
      this.interpolation = null;
    }
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getStateSnapshot() {
    return {
      listeningOk: this.listeningOk,
      port: this.port,
      lastListenError: this.lastListenError
        ? { message: this.lastListenError.message, code: this.lastListenError.code }
        : null,
      lastUpdate: this.lastUpdateData,
      stats: { ...this.stats },
    };
  }
}

module.exports = { TunaHttpServer };
