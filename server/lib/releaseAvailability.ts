import { Router } from 'express';
import type { RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';

type Title = {
  id: number;
  mediaType: string;
  title?: string;
  name?: string;
  originalTitle?: string;
  originalName?: string;
  originalLanguage?: string;
  releaseDate?: string;
  mediaInfo?: { status?: number };
};
type Release = {
  title: string;
  protocol?: string;
  categories?: { id: number; name: string }[];
  tmdbId?: number;
  indexer?: string;
  passwordProtected?: boolean;
};
type Entry = {
  state: 'found' | 'missing' | 'error';
  checkedAt: number;
  expiresAt: number;
  title: string;
  matches: { title: string; language: string; quality: number; indexer?: string }[];
  reason?: string;
  item?: Title & Record<string, unknown>;
};
type BuilderState = { page: number; lastFetchAt: number; nextFetchAt: number; added: number; error?: string };

export function movieCandidates(results: Record<string, any>[], now = Date.now()): Title[] {
  const cutoff = new Date(now - 45 * 86400000).toISOString().slice(0, 10);
  return results.filter(i => Number.isInteger(i.id) && i.id > 0 && i.title && !i.adult && i.release_date && i.release_date <= cutoff)
    .sort((a, b) => Number(['en', 'de'].includes(b.original_language)) - Number(['en', 'de'].includes(a.original_language)))
    .map(i => ({ id: i.id, mediaType: 'movie', title: i.title, originalTitle: i.original_title || i.title, originalLanguage: i.original_language, releaseDate: i.release_date,
      posterPath: i.poster_path, backdropPath: i.backdrop_path, overview: i.overview, genreIds: i.genre_ids ?? [], popularity: i.popularity, voteAverage: i.vote_average, voteCount: i.vote_count, adult: false, video: false }));
}

const normalize = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const foreign = /\b(italian|french|subfrench|spanish|russian|japanese|korean|hindi|dubbed)\b/i;

// A conservative preview policy, independent of Sonarr/Radarr's scoring engine.
// An indexed release is evidence of a candidate, never proof that it will unpack.
export function matchRelease(item: Title, release: Release) {
  if (!release.title || release.passwordProtected || (release.protocol && release.protocol !== 'usenet')) return null;
  const quality = /\b2160p\b/i.test(release.title) ? 2160 : /\b1080p\b/i.test(release.title) ? 1080 : 0;
  if (!quality) return null;
  const tv = item.mediaType === 'tv';
  const hasEpisode = /\bS\d{1,3}(?:E\d{1,3})?\b/i.test(release.title);
  if (tv !== hasEpisode) return null;
  const categories = release.categories ?? [];
  if (categories.length && !categories.some(c => tv ? c.id === 5000 || (c.id >= 5000 && c.id < 6000) || (c.id >= 105000 && c.id < 106000) : (c.id >= 2000 && c.id < 3000) || (c.id >= 102000 && c.id < 103000))) return null;
  if (release.tmdbId && release.tmdbId !== item.id) return null;
  if (!release.tmdbId) {
    const boundary = tv ? /[ ._-]+S\d{1,3}(?:E\d{1,3})?\b/i : /[ ._(-]+(?:19|20)\d{2}\b/;
    const prefix = release.title.split(boundary)[0];
    const names = [item.title, item.name, item.originalTitle, item.originalName].filter(Boolean) as string[];
    if (!names.some(n => normalize(n) === normalize(prefix))) return null;
    if (!tv && item.releaseDate) {
      const year = release.title.match(/\b((?:19|20)\d{2})\b/)?.[1];
      if (!year || year !== item.releaseDate.slice(0, 4)) return null;
    }
  }
  const germanSubtitles = /\b(?:german|deutsch)[ ._-]+(?:subbed|subs)\b/i.test(release.title);
  const explicitGerman = !germanSubtitles && /\b(german|deutsch)\b/i.test(release.title);
  const germanCategory = categories.some(c => /(?:\bDE\b|german|deutsch)/i.test(c.name));
  let language: string;
  if (explicitGerman || (!germanSubtitles && germanCategory && !foreign.test(release.title))) language = 'German';
  else if (foreign.test(release.title)) return null;
  else if (/\b(english|eng)\b/i.test(release.title)) language = 'English';
  else if (item.originalLanguage === 'en') language = 'English (inferred)';
  else return null;
  return { title: release.title, language, quality, indexer: release.indexer };
}

export class Availability {
  private cache = new Map<string, Entry>();
  private pending = new Map<string, Title>();
  private active?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private recent: { time: string; method: string; path: string; client: string; kept?: number; removed?: number }[] = [];
  private queries = 0;
  private candidates = new Map<string, Title>();
  private queryTimes: number[] = [];
  private nextCheckAt = 0;
  private builderTimer?: ReturnType<typeof setInterval>;
  private builderBusy = false;
  private builder: BuilderState = { page: 1, lastFetchAt: 0, nextFetchAt: 0, added: 0 };
  private stateFile = path.join(process.env.CONFIG_DIRECTORY ?? '/app/config', 'availability-builder.json');
  private budgetFile = path.join(process.env.CONFIG_DIRECTORY ?? '/app/config', 'availability-budget.json');
  private file = path.join(process.env.CONFIG_DIRECTORY ?? '/app/config', 'availability-cache.json');
  private base = process.env.PROWLARR_URL ?? 'http://prowlarr_server_1:9696';
  private key = process.env.PROWLARR_API_KEY ?? '';
  constructor() {
    try { this.key ||= JSON.parse(fs.readFileSync(path.join(path.dirname(this.file), 'availability-secrets.json'), 'utf8')).prowlarrApiKey ?? ''; } catch { /* Environment key is also supported. */ }
    try { this.cache = new Map(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* First start. */ }
    try { const b = JSON.parse(fs.readFileSync(this.budgetFile, 'utf8')); this.queryTimes = b.queryTimes ?? []; this.nextCheckAt = b.nextCheckAt ?? 0; } catch { /* First start. */ }
    try { const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); this.builder = { ...this.builder, ...s.builder }; this.pending = new Map(s.pending ?? []); } catch { /* First start. */ }
  }
  private saveBuilder() {
    try { fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify({ builder: this.builder, pending: [...this.pending] })); fs.renameSync(`${this.stateFile}.tmp`, this.stateFile); } catch { /* Runtime state remains usable. */ }
  }
  startBuilder() {
    if (process.env.AVAILABILITY_BUILDER !== 'true' || this.builderTimer) return;
    this.builderTimer = setInterval(() => void this.buildTick(), 60000);
    this.builderTimer.unref();
    void this.buildTick();
    if (this.pending.size) this.schedule(Math.max(1000, this.nextCheckAt - Date.now()));
  }
  stopBuilder() { if (this.builderTimer) clearInterval(this.builderTimer); this.builderTimer = undefined; }
  private async discoverCandidates(page: number) {
    const TheMovieDb = (await import('../api/themoviedb')).default;
    const data = await new TheMovieDb().getDiscoverMovies({ page, language: 'de', originalLanguage: 'all', sortBy: 'popularity.desc', primaryReleaseDateLte: new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10), voteCountGte: '50' });
    return { results: movieCandidates(data.results), totalPages: data.total_pages };
  }
  async buildTick() {
    if (this.builderBusy) return;
    this.builderBusy = true;
    try {
      // Renew one expired positive at a time; leave space for new movies.
      const expired = [...this.cache.entries()].find(([key, e]) => e.state === 'found' && e.expiresAt <= Date.now() && !this.pending.has(key) && this.active !== key);
      if (expired && this.pending.size < 50) {
        const [key, entry] = expired;
        const [mediaType, id] = key.split(':');
        this.enqueue({ id: Number(id), mediaType, ...(mediaType === 'movie' ? { title: entry.title } : { name: entry.title }), ...entry.item });
      }
      if (this.pending.size >= 10 || this.builder.nextFetchAt > Date.now()) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const data = await Promise.race([this.discoverCandidates(this.builder.page), new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Movie candidate lookup timed out')), 12000); })]);
        let added = 0;
        for (const item of data.results) {
          if (this.lookup(item) || this.pending.has(this.keyFor(item)) || this.active === this.keyFor(item)) continue;
          this.enqueue(item); added++;
        }
        this.builder = { page: this.builder.page >= Math.min(500, data.totalPages || 1) ? 1 : this.builder.page + 1, lastFetchAt: Date.now(), nextFetchAt: Date.now() + 15 * 60000, added: this.builder.added + added };
      } finally { if (timeout) clearTimeout(timeout); }
    } catch (error) {
      this.builder.error = error instanceof Error ? error.message : 'Candidate lookup failed';
      this.builder.nextFetchAt = Date.now() + 15 * 60000;
    } finally { this.builderBusy = false; this.saveBuilder(); }
  }
  keyFor(item: Title) { return `${item.mediaType}:${item.id}`; }
  lookup(item: Title) {
    const value = this.cache.get(this.keyFor(item));
    return value && value.expiresAt > Date.now() ? value : undefined;
  }
  catalogue(mediaType?: string, page = 1, filters: Record<string, unknown> = {}) {
    const supported = new Set(['page', 'sortBy', 'genre', 'language', 'primaryReleaseDateGte', 'primaryReleaseDateLte', 'firstAirDateGte', 'firstAirDateLte', 'voteAverageGte', 'voteAverageLte', 'voteCountGte', 'voteCountLte']);
    const unsupported = Object.keys(filters).some(key => !supported.has(key) && filters[key] !== '' && filters[key] !== undefined);
    const entries = [...this.cache.entries()].filter(([key, entry]) => {
      if (unsupported || entry.state !== 'found' || entry.expiresAt <= Date.now() || (mediaType && !key.startsWith(mediaType + ':'))) return false;
      const item: Record<string, unknown> = entry.item ?? {};
      if (filters.genre) {
        const genres = item.genreIds as number[] | undefined;
        if (!genres?.length) return false;
        // TMDB uses comma for AND and pipe for OR.
        const requested = String(filters.genre).split(/[|,]/).map(Number);
        if (String(filters.genre).includes('|') ? !requested.some(g => genres.includes(g)) : !requested.every(g => genres.includes(g))) return false;
      }
      if (filters.language && item.originalLanguage !== filters.language) return false;
      const date = (key.startsWith('tv:') ? item.firstAirDate : item.releaseDate) as string | undefined;
      const low = filters.primaryReleaseDateGte || filters.firstAirDateGte;
      const high = filters.primaryReleaseDateLte || filters.firstAirDateLte;
      if (low && (!date || date < String(low))) return false;
      if (high && (!date || date > String(high))) return false;
      for (const [name, field, minimum] of [['voteAverageGte', 'voteAverage', true], ['voteAverageLte', 'voteAverage', false], ['voteCountGte', 'voteCount', true], ['voteCountLte', 'voteCount', false]] as const) {
        if (filters[name] !== undefined && filters[name] !== '') {
          const value = Number(item[field]);
          if (!Number.isFinite(value) || (minimum ? value < Number(filters[name]) : value > Number(filters[name]))) return false;
        }
      }
      return true;
    });
    const [sort, direction] = String(filters.sortBy ?? '').split('.');
    if (sort) entries.sort(([, a], [, b]) => {
      const field = ({ original_title: 'title', name: 'name', original_name: 'name', release_date: 'releaseDate', first_air_date: 'firstAirDate', vote_average: 'voteAverage', popularity: 'popularity' } as Record<string, string>)[sort];
      if (!field) return 0;
      const left = a.item?.[field] ?? a.title;
      const right = b.item?.[field] ?? b.title;
      const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      return direction === 'desc' ? -comparison : comparison;
    });
    const results = entries.slice((page - 1) * 20, page * 20).map(([key, entry]) => {
      const [type, id] = key.split(':');
      return {
        id: Number(id), mediaType: type, popularity: 0, voteCount: 0, voteAverage: 0,
        genreIds: [], overview: 'A matching release was found by the availability checker.',
        originalLanguage: 'en', posterPath: null, backdropPath: null,
        ...(type === 'tv' ? { name: entry.title, originalName: entry.title, firstAirDate: '', originCountry: [] } : { title: entry.title, originalTitle: entry.title, releaseDate: '', adult: false, video: false }),
        ...entry.item,
      };
    });
    return { page, totalPages: Math.ceil(entries.length / 20), totalResults: entries.length, results };
  }
  private async metadata(item: Title): Promise<Title & Record<string, unknown>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const lookup = async () => {
        const TheMovieDb = (await import('../api/themoviedb')).default;
        const api = new TheMovieDb();
        const d = item.mediaType === 'tv' ? await api.getTvShow({ tvId: item.id }) : await api.getMovie({ movieId: item.id });
        const raw = d as unknown as Record<string, any>;
        return { ...item, overview: raw.overview, posterPath: raw.poster_path, backdropPath: raw.backdrop_path, originalLanguage: raw.original_language, genreIds: (raw.genres ?? []).map((g: { id: number }) => g.id), voteCount: raw.vote_count, voteAverage: raw.vote_average, popularity: raw.popularity, ...(item.mediaType === 'tv' ? { name: raw.name, originalName: raw.original_name, firstAirDate: raw.first_air_date, originCountry: raw.origin_country } : { title: raw.title, originalTitle: raw.original_title, releaseDate: raw.release_date, adult: raw.adult, video: raw.video }) };
      };
      return await Promise.race([lookup(), new Promise<Title>(resolve => { timer = setTimeout(() => resolve(item), 4000); })]);
    } catch { return item; }
    finally { if (timer) clearTimeout(timer); }
  }
  enqueue(item: Title) {
    if (!['movie', 'tv'].includes(item.mediaType) || !Number.isInteger(item.id) || item.id <= 0 || !(item.title || item.name)) return;
    const key = this.keyFor(item);
    if (this.lookup(item) || this.active === key || this.pending.has(key) || this.pending.size >= 100) return;
    this.pending.set(key, item);
    this.saveBuilder();
    this.schedule(Math.max(0, this.nextCheckAt - Date.now()));
  }
  private schedule(ms: number) {
    if (this.timer || this.active) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.work(); }, ms);
    this.timer.unref();
  }
  private async json(endpoint: string, base = this.base) {
    const response = await fetch(`${base}${endpoint}`, {
      headers: { 'X-Api-Key': this.key }, signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - Date.now() : 0;
      this.nextCheckAt = Date.now() + Math.max(3600000, seconds || 0);
      this.saveBudget();
    }
    if (!response.ok) throw new Error(`Prowlarr returned HTTP ${response.status}`);
    return response.json();
  }
  private saveBudget() {
    try { fs.writeFileSync(this.budgetFile, JSON.stringify({ queryTimes: this.queryTimes, nextCheckAt: this.nextCheckAt })); } catch { /* Read-only configs still retain the budget in memory. */ }
  }
  private async work() {
    this.queryTimes = this.queryTimes.filter(t => t > Date.now() - 3600000);
    const hourlyLimit = Math.max(1, Math.min(6, Number(process.env.AVAILABILITY_HOURLY_LIMIT ?? 6)));
    if (this.queryTimes.length >= hourlyLimit) this.nextCheckAt = Math.max(this.nextCheckAt, this.queryTimes[0] + 3600000);
    if (this.nextCheckAt > Date.now()) { this.schedule(this.nextCheckAt - Date.now()); return; }
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [key, item] = next;
    this.pending.delete(key);
    this.active = key;
    const now = Date.now();
    let entry: Entry;
    try {
      if (!this.key) throw new Error('Prowlarr key is not configured');
      const [indexers, statuses] = await Promise.all([this.json('/api/v1/indexer'), this.json('/api/v1/indexerstatus')]);
      // Respect the production instance's backoff too: accounts/quotas are shared.
      const sharedBase = process.env.PROWLARR_SHARED_STATUS_URL;
      const shared = sharedBase ? await this.json('/api/v1/indexerstatus', sharedBase) : [];
      const sharedUntil = Math.max(0, ...shared.map((s: { disabledTill?: string }) => Date.parse(s.disabledTill ?? '') || 0));
      if (sharedUntil > Date.now()) {
        this.nextCheckAt = Math.max(this.nextCheckAt, sharedUntil);
        this.saveBudget();
        throw new Error('Production indexer is backing off; background checks deferred');
      }
      const blocked = new Set(statuses.filter((s: { disabledTill?: string }) => Date.parse(s.disabledTill ?? '') > Date.now()).map((s: { indexerId: number }) => s.indexerId));
      const enabled = indexers.filter((i: { enable: boolean; protocol: string }) => i.enable && i.protocol === 'usenet');
      if (!enabled.length || enabled.some((i: { id: number }) => blocked.has(i.id))) throw new Error('One or more Usenet indexers are unavailable/backing off; check deferred');
      const query = new URLSearchParams({ query: item.originalTitle || item.originalName || item.title || item.name || '', type: 'search', limit: '100', categories: item.mediaType === 'tv' ? '5000' : '2000' });
      this.queryTimes.push(Date.now());
      this.nextCheckAt = Date.now() + Math.max(60000, Number(process.env.AVAILABILITY_INTERVAL_MS ?? 600000));
      this.saveBudget();
      this.queries++;
      const releases: Release[] = await this.json(`/api/v1/search?${query}`);
      // Search can return [] with HTTP 200 on provider errors. Do not call that missing.
      const after = await this.json('/api/v1/indexerstatus');
      if (after.some((s: { disabledTill?: string }) => Date.parse(s.disabledTill ?? '') > Date.now())) throw new Error('Indexer failed during search; availability unknown');
      const matches = releases.map(r => matchRelease(item, r)).filter(Boolean) as Entry['matches'];
      matches.sort((a, b) => (Number(b.language === 'German') - Number(a.language === 'German')) || b.quality - a.quality);
      const positiveHours = Math.max(1, Math.min(24, Number(process.env.AVAILABILITY_POSITIVE_TTL_HOURS ?? 6)));
      entry = { state: matches.length ? 'found' : 'missing', title: item.title || item.name || '', checkedAt: now, expiresAt: now + (matches.length ? positiveHours * 3600000 : 3600000), matches: matches.slice(0, 5) };
      if (matches.length) entry.item = await this.metadata(item);
    } catch (error) {
      entry = { state: 'error', title: item.title || item.name || '', checkedAt: now, expiresAt: now + 60000, matches: [], reason: error instanceof Error ? error.message : 'Check failed' };
      this.nextCheckAt = Math.max(this.nextCheckAt, Date.now() + 15 * 60000);
      this.saveBudget();
      // Keep failed work for a later retry; do not spend budget walking the queue during an outage.
      this.pending.set(key, item);
    }
    this.cache.set(key, entry);
    if (this.cache.size > 3000) this.cache.delete(this.cache.keys().next().value!);
    try { fs.writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.cache])); fs.renameSync(`${this.file}.tmp`, this.file); } catch { /* Diagnostics remain available in memory. */ }
    this.active = undefined;
    this.saveBuilder();
    if (this.pending.size) this.schedule(Math.max(10000, this.nextCheckAt - Date.now()));
  }
  record(req: { method: string; path: string; headers: { [key: string]: unknown } }, counts = {}) {
    // Deliberately omit query strings, credentials, request bodies, and cookies.
    this.recent.unshift({ time: new Date().toISOString(), method: req.method, path: req.path, client: String(req.headers['user-agent'] ?? '').slice(0, 160), ...counts });
    this.recent.length = Math.min(this.recent.length, 100);
  }
  status() {
    return { sandbox: true, builder: { ...this.builder, enabled: process.env.AVAILABILITY_BUILDER === 'true' }, autoCheck: process.env.AVAILABILITY_AUTO_CHECK === 'true', nextCheckAt: this.nextCheckAt, hourlySearches: this.queryTimes.filter(t => t > Date.now() - 3600000).length, policy: '1080p/2160p; German preferred, English fallback (unmarked English inferred from original language). TV means at least one matching release, not complete seasons.', active: this.active, queued: this.pending.size, searches: this.queries, candidates: [...this.candidates.values()].filter(i => !this.lookup(i)), entries: [...this.cache].map(([key, value]) => ({ key, ...value })), recent: this.recent };
  }
  async filter(body: { results: Title[] }, req: Parameters<Availability['record']>[0]) {
    const candidates = body.results.filter(i => ['movie', 'tv'].includes(i.mediaType));
    candidates.forEach(i => {
      this.candidates.set(this.keyFor(i), i);
      if (this.candidates.size > 100) this.candidates.delete(this.candidates.keys().next().value!);
      if (process.env.AVAILABILITY_AUTO_CHECK === 'true') this.enqueue(i);
    });
    // Keep the HTTP API responsive. Warming continues independently of this request.
    if (process.env.AVAILABILITY_AUTO_CHECK === 'true' && candidates.some(i => !this.lookup(i))) await new Promise(resolve => setTimeout(resolve, 750));
    const results = candidates.filter(i => this.lookup(i)?.state === 'found');
    this.record(req, { kept: results.length, removed: body.results.length - results.length });
    return { ...body, results };
  }
}

export const availability = new Availability();

// These general rows represent the checked catalogue, rather than an intersection
// with an unrelated TMDB trending page. Register behind administrator auth.
export const availabilityCatalogue: RequestHandler = (req, res, next) => {
  if (req.method !== 'GET' || !['/trending', '/tv', '/movies'].includes(req.path)) return next();
  const page = Math.max(1, Number(req.query.page) || 1);
  res.setHeader('X-Availability-Filter', 'checked-catalogue');
  res.json(availability.catalogue(req.path === '/tv' ? 'tv' : req.path === '/movies' ? 'movie' : undefined, page, req.query));
};

export const availabilityMiddleware: RequestHandler = (req, res, next) => {
  if (process.env.AVAILABILITY_SANDBOX !== 'true') return next();
  if (req.path.startsWith('/api/v1/')) availability.record(req);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.path.startsWith('/api/v1/') && !req.path.startsWith('/api/v1/auth/')) {
    res.status(403).json({ message: 'Availability sandbox: requests and service mutations are disabled. Your production services are untouched.' });
    return;
  }
  const route = req.path.replace('/api/v1', '');
  if (req.method !== 'GET' || !(/^\/(discover|search)(\/|$)/.test(route) || /^\/(movie|tv)\/\d+\/(recommendations|similar)$/.test(route) || /^\/collection\/\d+$/.test(route))) return next();
  const original = res.json.bind(res);
  res.json = ((body: { results?: Title[]; parts?: Title[] }) => {
    if (res.statusCode !== 200 || (!Array.isArray(body.results) && !Array.isArray(body.parts))) return original(body);
    const property = Array.isArray(body.results) ? 'results' : 'parts';
    const entries = (body[property] ?? []) as Title[];
    // Leave genre/studio/provider navigation cards alone.
    if (!entries.some(i => ['movie', 'tv'].includes(i.mediaType))) return original(body);
    void availability.filter({ ...body, results: entries }, req).then(filtered => {
      res.setHeader('X-Availability-Filter', 'cached-candidates-only');
      if (property === 'parts') { const { results, ...rest } = filtered; original({ ...rest, parts: results }); }
      else original(filtered);
    }).catch(() => { original({ ...body, [property]: [] }); });
    return res;
  }) as typeof res.json;
  next();
};

export const availabilityRouter = Router();
availabilityRouter.get('/status', (_req, res) => { res.json(availability.status()); });
availabilityRouter.get('/check', (req, res) => {
  const item: Title = { id: Number(req.query.id), mediaType: String(req.query.type), title: String(req.query.title ?? '').slice(0, 200), originalLanguage: String(req.query.language ?? 'en'), releaseDate: String(req.query.year ?? '') };
  if (!Number.isInteger(item.id) || item.id < 1 || !['tv', 'movie'].includes(item.mediaType) || !item.title) { res.status(400).json({ message: 'Provide id, type=tv|movie and title' }); return; }
  availability.enqueue(item);
  res.json({ state: availability.lookup(item) ?? 'queued' });
});
