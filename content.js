/**
 * content.js — UI injection + Instagram data extraction.
 *
 * Data strategy (best quality first, every step has a fallback):
 *   1. Instagram's private web API  (/api/v1/media/<id>/info/, reels_media, feed/user)
 *      using the user's own logged-in session → full candidate list, we pick the largest.
 *   2. Items sniffed from Instagram's own network traffic by inject.js (cache below).
 *   3. DOM scraping (largest srcset image / non-blob <video>) as a last resort.
 *
 * UI strategy: all floating widgets live in ONE fixed overlay (#ighd-root) appended to <html>
 * and are positioned over the visible media with getBoundingClientRect(). This means we never
 * insert nodes into React-managed subtrees (which can crash or get wiped on re-render).
 * The profile toolbar is the one exception (it must sit next to the header) and is re-injected
 * automatically if React removes it.
 */
(() => {
  'use strict';
  if (window.__ighdContent) return;
  window.__ighdContent = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const IG_APP_ID = '936619743392459';
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const RESERVED = new Set(['explore', 'reels', 'reel', 'p', 'tv', 'stories', 'direct', 'accounts', 'about',
    'legal', 'api', 'developer', 'directory', 'web', 'challenge', 'emails', 'nametag', 'session', 'oauth',
    'privacy', 'fxcal', 'ar', 'lite', 'threads', 'settings', 'notifications']);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICON_DL = 'M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z';
  const ICON_CHEV = 'M7 10l5 5 5-5z';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // =================================================================== tiny DOM helpers
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c);
    return el;
  }
  function icon(d) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '18');
    s.setAttribute('height', '18');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'currentColor');
    s.append(p);
    return s;
  }

  // =================================================================== overlay + toast
  const root = h('div', { class: 'ighd-root' });
  const toastEl = h('div', { class: 'ighd-toast', role: 'status', 'aria-live': 'polite' });
  root.append(toastEl);
  document.documentElement.append(root);

  let toastTimer = null;
  function toast(msg, { sticky = false, error = false } = {}) {
    toastEl.textContent = msg;
    toastEl.className = 'ighd-toast ighd-show' + (error ? ' ighd-error' : '');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => toastEl.classList.remove('ighd-show'), error ? 7000 : 3500);
  }

  // =================================================================== data cache (from inject.js)
  const cache = { byCode: new Map(), byPk: new Map(), userIds: new Map() };

  const isCompleteNode = (n) => (n.media_type === 2 || n.video_versions?.length)
    ? !!n.video_versions?.length
    : !!n.image_versions2?.candidates?.length;
  function isComplete(item) {
    if (item.carousel_media) return item.carousel_media.length > 0 && item.carousel_media.every(isCompleteNode);
    if (item.media_type === 8) return false; // carousel without children → partial
    return isCompleteNode(item);
  }
  function remember(item) {
    const score = (x) => (isComplete(x) ? 2 : 1);
    if (item.code) {
      const old = cache.byCode.get(item.code);
      if (!old || score(item) >= score(old)) cache.byCode.set(item.code, item);
    }
    if (item.pk) cache.byPk.set(item.pk, item);
    if (item.user?.username && item.user.pk) cache.userIds.set(item.user.username.toLowerCase(), item.user.pk);
    for (const m of [cache.byCode, cache.byPk]) if (m.size > 2500) m.delete(m.keys().next().value);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'IGHD') return;
    if (d.type === 'ITEMS' && Array.isArray(d.items)) d.items.forEach(remember);
    else if (d.type === 'NAV') schedule(true);
  });

  // =================================================================== Instagram API access
  class IgError extends Error {
    constructor(msg, fatal = false) { super(msg); this.fatal = fatal; }
  }

  function igHeaders() {
    const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
    let claim = '0';
    try { claim = sessionStorage.getItem('www-claim-v2') || '0'; } catch (_) { /* ignore */ }
    return {
      'x-ig-app-id': IG_APP_ID,
      'x-asbd-id': '129477',
      'x-csrftoken': csrf,
      'x-ig-www-claim': claim,
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
    };
  }

  // Serialise + space out API calls (≥350 ms apart) to stay well under Instagram's rate limits.
  let lastCall = Promise.resolve();
  const throttle = (ms = 350) => { const p = lastCall.then(() => sleep(ms)); lastCall = p; return p; };

  async function igGet(path, retries = 3) {
    for (let attempt = 0; ; attempt++) {
      await throttle();
      let res;
      try {
        res = await fetch(path, { credentials: 'include', headers: igHeaders() });
      } catch (e) {
        if (attempt >= retries) throw new IgError('Network error while contacting Instagram');
        await sleep(1500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= retries) throw new IgError('Instagram is rate-limiting requests. Wait a few minutes and retry.', res.status === 429);
        await sleep(2500 * 2 ** attempt + Math.random() * 500);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new IgError('Instagram refused the request. Are you logged in?', true);
      if (res.status === 404) throw new IgError(`Not found (404): ${path.split('?')[0]} — deleted, expired, private, or Instagram changed this endpoint.`);
      if (!res.ok) throw new IgError(`Instagram returned HTTP ${res.status}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch (_) { throw new IgError('Unexpected response from Instagram. Are you logged in?', true); }
    }
  }

  function shortcodeToId(code) {
    let id = 0n;
    for (const ch of code.slice(0, 11)) {       // first 11 chars = the media id (extra chars = private-post suffix)
      const i = ALPHABET.indexOf(ch);
      if (i < 0) throw new IgError('Invalid post code');
      id = id * 64n + BigInt(i);
    }
    return id.toString();
  }

  async function fetchMediaInfo(code) {
    const data = await igGet(`/api/v1/media/${shortcodeToId(code)}/info/`);
    const item = data?.items?.[0];
    if (!item) throw new IgError('Post data missing in response');
    return item;
  }

  /** Profile feed page. Tries the id endpoint, then the username endpoint if Instagram 404s. */
  async function fetchUserFeed(username, userId, maxId) {
    const q = `count=33${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`;
    try {
      return await igGet(`/api/v1/feed/user/${userId}/?${q}`);
    } catch (e) {
      if (e.fatal || !/404/.test(e.message)) throw e;
      return igGet(`/api/v1/feed/user/${encodeURIComponent(username)}/username/?${q}`);
    }
  }

  async function getUserId(username) {
    const key = username.toLowerCase();
    if (cache.userIds.has(key)) return cache.userIds.get(key);
    const d = await igGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const id = d?.data?.user?.id;
    if (!id) throw new IgError(`User "${username}" not found or not accessible`);
    cache.userIds.set(key, id);
    return id;
  }

  /** Highest video + audio representation from a DASH manifest (what Instagram's player streams for 1080p). */
  function parseDash(xml) {
    if (!xml || typeof xml !== 'string') return null;
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      let bv = null, ba = null;
      for (const r of doc.querySelectorAll('Representation')) {
        const url = (r.querySelector('BaseURL') || {}).textContent;
        if (!url) continue;
        const par = r.parentElement;
        const mime = r.getAttribute('mimeType') || (par && par.getAttribute('mimeType')) || '';
        const ct = (par && par.getAttribute('contentType')) || '';
        const bw = +r.getAttribute('bandwidth') || 0, w = +r.getAttribute('width') || 0, hh = +r.getAttribute('height') || 0;
        if (/video/.test(mime) || ct === 'video') {
          if (!bv || w * hh > bv.w * bv.h || (w * hh === bv.w * bv.h && bw > bv.bw)) bv = { url: url.trim(), w, h: hh, bw };
        } else if (/audio/.test(mime) || ct === 'audio') {
          if (!ba || bw > ba.bw) ba = { url: url.trim(), bw };
        }
      }
      return bv ? { videoUrl: bv.url, width: bv.w, height: bv.h, audioUrl: ba ? ba.url : null } : null;
    } catch (_) { return null; }
  }

  // Video quality mode: 'progressive' (single MP4 with audio, usually ≤720p) or 'dash' (best video + audio as 2 files)
  let videoMode = 'progressive';
  api.storage.local.get({ videoMode }).then((s) => { videoMode = s.videoMode; }).catch(() => {});
  api.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.videoMode) videoMode = ch.videoMode.newValue; });

  // =================================================================== normalisation
  const area = (c) => (c.width || 0) * (c.height || 0);
  const bestBy = (arr) => (arr && arr.length ? [...arr].sort((a, b) => area(b) - area(a))[0] : null);

  function fileKey(u) {
    if (!u || u.startsWith('blob:')) return null;
    try { return new URL(u, location.href).pathname.split('/').pop() || null; } catch (_) { return null; }
  }

  /** One slide/story item → {id,type,url,width,height,takenAt,keys} (or null if no usable URL). */
  function toMedia(n, fallbackTs) {
    const isVideo = n.media_type === 2 || !!n.video_versions?.length;
    const best = isVideo ? bestBy(n.video_versions) : bestBy(n.image_versions2?.candidates);
    const dash = isVideo ? (n.dash || parseDash(n.video_dash_manifest)) : null;
    if (!best?.url && !dash?.videoUrl) return null;
    const better = dash && dash.videoUrl && (dash.height || 0) > ((best && best.height) || 0);
    return {
      id: String(n.pk || n.id || '').split('_')[0],
      type: isVideo ? 'video' : 'image',
      url: best?.url || dash.videoUrl,
      width: best?.width || (dash && dash.width),
      height: best?.height || (dash && dash.height),
      dash: better ? dash : null,                    // only kept when it beats the progressive MP4
      takenAt: n.taken_at || fallbackTs || null,
      keys: (n.image_versions2?.candidates || []).map((x) => fileKey(x.url)).filter(Boolean),
    };
  }

  function normalizePost(item) {
    const kids = item.carousel_media?.length ? item.carousel_media : [item];
    const media = kids.map((k) => toMedia(k, item.taken_at)).filter(Boolean);
    media.forEach((m, i) => { m.index = i; });
    return {
      kind: 'post',
      id: String(item.pk || item.id || '').split('_')[0],
      code: item.code || null,
      username: item.user?.username || 'unknown',
      userId: item.user?.pk || null,
      takenAt: item.taken_at || null,
      media,
      skipped: kids.length - media.length,
    };
  }

  /** API first (guaranteed full-size), then sniffed cache. */
  async function getPost(code) {
    let item = null, apiErr = null;
    try { item = await fetchMediaInfo(code); } catch (e) { apiErr = e; }
    if (!item) {
      const c = cache.byCode.get(code);
      if (c && isComplete(c)) item = c;
    }
    if (!item) throw apiErr || new IgError('Post data unavailable');
    const post = normalizePost(item);
    if (!post.media.length) throw new IgError('No downloadable media found in this post');
    return post;
  }

  // =================================================================== DOM inspection helpers
  /** Largest ≥150px <img>/<video> that is actually on screen inside `root`. */
  function visibleMediaEl(rootEl, viewport = false) {
    const rr = viewport
      ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight }
      : rootEl.getBoundingClientRect();
    let best = null, bestArea = 0;
    for (const el of rootEl.querySelectorAll('video, img')) {
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 150) continue;       // avatars, icons, emoji
      const w = Math.min(r.right, rr.right) - Math.max(r.left, rr.left);
      const hh = Math.min(r.bottom, rr.bottom) - Math.max(r.top, rr.top);
      if (w <= 0 || hh <= 0) continue;
      if (w * hh > bestArea) { bestArea = w * hh; best = el; }
    }
    return best;
  }

  function findCode(el) {
    const re = /\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/;
    for (const a of el.querySelectorAll('a[href]')) {
      const m = (a.getAttribute('href') || '').match(re);
      if (m) return m[1];
    }
    const m = location.pathname.match(re);
    return m ? m[1] : null;
  }

  /** Carousel pagination dots: small empty divs where exactly one has a unique class (the active one). */
  function findDots(rootEl) {
    for (const c of rootEl.querySelectorAll('div')) {
      const k = c.children;
      if (k.length < 2 || k.length > 20) continue;
      let ok = true;
      for (const x of k) if (x.tagName !== 'DIV' || x.children.length || !x.offsetWidth || x.offsetWidth > 12) { ok = false; break; }
      if (!ok) continue;
      const cls = [...k].map((x) => x.className);
      const uniq = cls.map((v, i) => (cls.filter((y) => y === v).length === 1 ? i : -1)).filter((i) => i >= 0);
      if (uniq.length === 1) return { count: k.length, active: uniq[0] };
    }
    return null;
  }

  /** Which slide of the carousel is on screen? Edge buttons → dots → file-name match → 0. */
  function getVisibleIndex(rootEl, post) {
    const n = post.media.length;
    const has = (sel) => !!rootEl.querySelector(sel);
    const next = has('button[aria-label="Next"],[role="button"][aria-label="Next"]');
    const prev = has('button[aria-label="Go back"],[role="button"][aria-label="Go back"]');
    if (next && !prev) return { index: 0, certain: true };
    if (!next && prev) return { index: n - 1, certain: true };
    const dots = findDots(rootEl);
    if (dots && dots.count === n) return { index: dots.active, certain: true };
    const el = visibleMediaEl(rootEl);
    if (el) {
      const k = fileKey(el.tagName === 'VIDEO' ? el.poster : (el.currentSrc || el.src));
      if (k) {
        const i = post.media.findIndex((m) => m.keys.includes(k));
        if (i >= 0) return { index: i, certain: true };
      }
    }
    return { index: 0, certain: false };
  }

  function largestFromSrcset(img) {
    const set = img.getAttribute('srcset');
    if (!set) return null;
    let best = null, bw = 0;
    for (const part of set.split(',')) {
      const [u, w] = part.trim().split(/\s+/);
      const width = parseInt(w, 10) || 0;
      if (u && width >= bw) { best = u; bw = width; }
    }
    return best;
  }

  /** Last resort when the API and cache both fail. */
  function domFallback(el) {
    const m = visibleMediaEl(el);
    if (!m) return null;
    let url, type = 'image';
    if (m.tagName === 'VIDEO') {
      type = 'video';
      const s = m.currentSrc || m.src;
      if (!s || s.startsWith('blob:')) return null;     // blob streams can't be saved without the API
      url = s;
    } else {
      url = largestFromSrcset(m) || m.currentSrc || m.src;
    }
    if (!url) return null;
    const code = findCode(el) || String(Date.now());
    const username = el.querySelector('header a[href^="/"]')?.textContent?.trim() || location.pathname.split('/')[1] || 'unknown';
    return {
      kind: 'post', id: code, code, username, takenAt: Math.floor(Date.now() / 1000),
      media: [{ id: code, type, url, index: 0, keys: [] }], index: 0, degraded: true,
    };
  }

  // =================================================================== stories
  async function resolveStory() {
    const path = location.pathname;
    let reelId, username = null, curId = null;
    let m = path.match(/^\/stories\/highlights\/(\d+)/);
    if (m) {
      reelId = `highlight:${m[1]}`;
    } else {
      m = path.match(/^\/stories\/([^/]+)\/?(\d+)?/);
      if (!m) throw new IgError('Unrecognised story URL');
      username = decodeURIComponent(m[1]);
      curId = m[2] || null;
      reelId = await getUserId(username);
    }
    const data = await igGet(`/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`);
    const reel = data?.reels?.[reelId] || data?.reels_media?.[0];
    if (!reel?.items?.length) throw new IgError('Story not available (expired or private)');
    username = reel.user?.username || username || 'unknown';
    const media = reel.items.map((it) => toMedia(it, it.taken_at)).filter(Boolean);
    media.forEach((x, i) => { x.index = i; });
    let index = curId ? media.findIndex((x) => x.id === curId) : -1;
    const certain = index >= 0;
    if (!certain) index = 0;
    return {
      kind: 'story', id: String(reelId), code: null, username, takenAt: reel.items[0]?.taken_at || null,
      media, index, uncertain: !certain, skipped: reel.items.length - media.length,
    };
  }

  async function resolvePackage(host) {
    if (host.kind === 'story') return resolveStory();
    const code = findCode(host.el);
    if (!code) throw new IgError('Could not determine which post this is');
    let post;
    try {
      post = await getPost(code);
    } catch (err) {
      const dom = domFallback(host.el);
      if (dom) return dom;
      throw err;
    }
    if (post.media.length === 1 || host.grid) return { ...post, index: 0 };
    const { index, certain } = getVisibleIndex(host.el, post);
    return { ...post, index, uncertain: !certain };
  }

  // =================================================================== download plumbing
  function fmtTs(sec) {
    const d = sec ? new Date(sec * 1000) : new Date();
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');   // e.g. 20261105T101500Z
  }

  /** One media entry -> download items. In 'dash' mode a better-than-progressive video becomes video + audio files. */
  function toItem(pkg, m) {
    const multi = pkg.media.length > 1;
    const id = pkg.kind === 'story'
      ? m.id
      : (multi ? `${pkg.code || pkg.id}_${String(m.index + 1).padStart(2, '0')}` : (pkg.code || pkg.id));
    const common = { username: pkg.username, timestamp: fmtTs(m.takenAt || pkg.takenAt) };
    if (m.type === 'video' && videoMode === 'dash' && m.dash) {
      const out = [{ ...common, url: m.dash.videoUrl, kind: 'video', id: `${id}_video`, ext: 'mp4' }];
      if (m.dash.audioUrl) out.push({ ...common, url: m.dash.audioUrl, kind: 'audio', id: `${id}_audio`, ext: 'm4a' });
      return out;
    }
    return [{ ...common, url: m.url, kind: m.type, id }];
  }

  const filterMedia = (list, action) =>
    action === 'images' ? list.filter((m) => m.type === 'image')
      : action === 'videos' ? list.filter((m) => m.type === 'video')
        : list;

  async function sendItems(items, note = '') {
    if (!items.length) { toast('Nothing matching to download'); return 0; }
    if (items.length > 50 && !confirm(`Download ${items.length} files? They will be queued and saved gradually.`)) {
      toast('Cancelled'); return 0;
    }
    let res;
    try {
      res = await api.runtime.sendMessage({ type: 'ENQUEUE', items });
    } catch (e) {
      if (/context invalidated|Receiving end/i.test(String(e?.message))) {
        throw new IgError('The extension was updated or reloaded — please refresh this Instagram tab.');
      }
      throw e;
    }
    if (!res?.ok) throw new IgError(res?.error || 'Download request was rejected');
    toast(`Queued ${res.queued} file${res.queued === 1 ? '' : 's'}${note}`);
    return res.queued;
  }

  // Progress pushed from background.js
  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'DL_PROGRESS') return;
    const s = msg.status;
    const finished = s.done + s.failed;
    if (finished >= s.total) {
      toast(`Finished: ${s.done} saved${s.failed ? `, ${s.failed} failed (see extension popup)` : ''}`, { error: !!s.failed });
    } else {
      toast(`Downloading ${finished}/${s.total}${s.failed ? ` (${s.failed} failed)` : ''}…`, { sticky: true });
    }
  });

  // =================================================================== per-post widget
  async function runPostAction(widget, action) {
    if (widget.busy) return;
    widget.setBusy(true);
    try {
      toast('Fetching media info…', { sticky: true });
      const pkg = await resolvePackage(widget.host);
      let list = action === 'current' ? [pkg.media[pkg.index]] : filterMedia(pkg.media, action);
      list = list.filter(Boolean);
      if (!list.length) { toast(action === 'videos' ? 'This post has no videos' : 'No matching media found'); return; }
      let note = '';
      if (pkg.degraded) note = ' (API unavailable — saved on-page quality)';
      else if (pkg.uncertain && action === 'current') note = ' (could not detect the visible slide — saved the first; use "whole post" to get all)';
      else if (pkg.skipped) note = ` (${pkg.skipped} item(s) had no downloadable URL)`;
      await sendItems(list.flatMap((m) => toItem(pkg, m)), note);
    } catch (e) {
      console.error('[IG HiRes Downloader]', e);
      toast(e.message || 'Download failed', { error: true });
    } finally {
      widget.setBusy(false);
    }
  }

  class Widget {
    constructor(host) {
      this.host = host;
      this.busy = false;
      const wholeLabel = host.kind === 'story' ? 'Download the whole story' : 'Download the whole post';
      const primary = host.grid ? 'all' : 'current';   // grid tiles have no "current slide" → whole post
      this.main = h('button', {
        class: 'ighd-btn ighd-main', type: 'button',
        title: host.grid ? 'Download this post (max quality)' : 'Download this item (max quality)',
        'aria-label': 'Download', onclick: (e) => this.fire(e, primary),
      }, icon(ICON_DL));
      this.arrow = h('button', {
        class: 'ighd-btn ighd-arrow', type: 'button', title: 'More download options',
        'aria-label': 'More download options', 'aria-haspopup': 'menu',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); this.el.classList.toggle('ighd-open'); },
      }, icon(ICON_CHEV));
      this.menu = h('div', { class: 'ighd-menu', role: 'menu' },
        ...[['images', 'Download all images'], ['videos', 'Download all videos'], ['all', wholeLabel]].map(([a, label]) =>
          h('button', { class: 'ighd-item', type: 'button', role: 'menuitem', onclick: (e) => this.fire(e, a) }, label)));
      this.el = h('div', { class: 'ighd-widget ighd-hidden' + (host.grid ? ' ighd-grid' : '') }, this.main, this.arrow, this.menu);
      root.append(this.el);
    }
    fire(e, action) {
      e.preventDefault(); e.stopPropagation();
      this.el.classList.remove('ighd-open');
      runPostAction(this, action);
    }
    setBusy(b) { this.busy = b; this.el.classList.toggle('ighd-busy', b); }
    destroy() { this.el.remove(); }
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.ighd-widget')) return;
    root.querySelectorAll('.ighd-open').forEach((w) => w.classList.remove('ighd-open'));
  }, true);

  // =================================================================== host discovery + positioning
  const widgets = new Map(); // key (Element | string) -> Widget

  function discoverHosts() {
    if (/^\/stories\//.test(location.pathname)) {
      return [{ key: 'story', el: document.body, kind: 'story', viewport: true }];
    }
    const hosts = [];
    document.querySelectorAll('article').forEach((a) => hosts.push({ key: a, el: a, kind: 'post' }));
    if (!hosts.length && /^\/(?:p|reel|tv)\/[^/]+/.test(location.pathname)) {
      hosts.push({ key: 'page', el: document.querySelector('main') || document.body, kind: 'post' });
    }
    // Profile grid: one widget per tile near the viewport (top-right corner of the tile).
    if (!hosts.length && profileUsername()) {
      document.querySelectorAll('main a[href]').forEach((a) => {
        if (!/\/(?:p|reel|tv)\/[A-Za-z0-9_-]+/.test(a.getAttribute('href') || '')) return;
        const r = a.getBoundingClientRect();
        // Tile = big box. (No <img> requirement: the Reels tab draws thumbnails as CSS backgrounds.)
        if (r.width < 80 || r.height < 80) return;
        if (r.bottom < -400 || r.top > innerHeight + 400) return;
        hosts.push({ key: a, el: a, kind: 'post', grid: true });
      });
    }
    return hosts;
  }

  function reposition() {
    const dialog = document.querySelector('div[role="dialog"]');
    for (const w of widgets.values()) {
      const { host } = w;
      const grid = !!host.grid;
      let rect = null;
      const blocked = dialog && host.key instanceof Element && !dialog.contains(host.key);
      if (!blocked) {
        if (grid) {
          const r = host.el.getBoundingClientRect();
          if (r.width > 0 && r.bottom > 0 && r.top < innerHeight) rect = r;
        } else {
          let inView = true;
          if (!host.viewport) {
            const ar = host.el.getBoundingClientRect();
            inView = ar.bottom > 0 && ar.top < innerHeight;
          }
          if (inView) { const el = visibleMediaEl(host.el, !!host.viewport); rect = el && el.getBoundingClientRect(); }
        }
      }
      const off = !rect || rect.right < 0 || rect.left > innerWidth ||
        (!grid && (rect.bottom < 56 || rect.top > innerHeight - 56));
      if (off) { w.el.classList.add('ighd-hidden'); continue; }
      w.el.classList.remove('ighd-hidden');
      const pad = grid ? 6 : 8;
      const x = Math.min(rect.right - pad, innerWidth - 8);                 // widget's RIGHT edge (see translateX(-100%))
      const y = grid ? rect.top + pad : Math.min(Math.max(rect.top + 8, 8), rect.bottom - 44);
      w.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translateX(-100%)`;
    }
  }

  // =================================================================== profile toolbar
  let barEl = null;
  let profileBusy = false;

  function profileUsername() {
    const m = location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/(?:reels\/|tagged\/)?$/);
    if (!m || RESERVED.has(m[1].toLowerCase())) return null;
    return m[1];
  }

  function gridCodes() {
    const out = new Set();
    document.querySelectorAll('main a[href]').forEach((a) => {
      const m = (a.getAttribute('href') || '').match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
      if (m) out.add(m[1]);
    });
    return [...out];
  }

  async function collectProfile(username, say) {
    const { profileScope, maxPosts } = await api.storage.local.get({ profileScope: 'loaded', maxPosts: 100 });
    const posts = [];
    const seen = new Set();
    const add = (it) => {
      const p = normalizePost(it);
      const key = p.id || p.code;
      if (p.media.length && !seen.has(key)) { seen.add(key); posts.push(p); }
    };

    if (profileScope === 'all') {
      const userId = await getUserId(username);
      let maxId = null, fetched = 0;
      while (fetched < maxPosts) {
        const d = await fetchUserFeed(username, userId, maxId);
        for (const it of d.items || []) { if (fetched >= maxPosts) break; add(it); fetched++; }
        say(`Reading posts… ${fetched}`);
        if (!d.more_available || !d.next_max_id) break;
        maxId = d.next_max_id;
      }
    } else {
      const codes = gridCodes();
      if (!codes.length) throw new IgError('No posts are loaded in the grid yet. Scroll down, or set scope to "All posts" in the extension popup.');
      let i = 0, failed = 0;
      for (const code of codes) {
        i++;
        say(`Reading posts… ${i}/${codes.length}`);
        const c = cache.byCode.get(code);
        if (c && isComplete(c)) { add(c); continue; }
        try { add(await fetchMediaInfo(code)); } catch (e) { failed++; if (e.fatal) throw e; }
      }
      if (failed) toast(`${failed} post(s) could not be read and were skipped`);
    }
    if (!posts.length) throw new IgError('No downloadable media found');
    return posts;
  }

  function flatten(posts, action) {
    const out = [];
    const seen = new Set();
    for (const p of posts) {
      for (const m of filterMedia(p.media, action)) {
        const k = fileKey(m.url) || m.url;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(...toItem(p, m));
      }
    }
    return out;
  }

  // ---- full-profile census: how many photos / videos / files this account has uploaded -------------
  const profileStats = new Map(); // lower-case username -> stats

  async function countProfile(username, say) {
    const info = await igGet(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
    const u = info?.data?.user;
    if (!u?.id) throw new IgError(`User "${username}" not found or not accessible`);
    cache.userIds.set(username.toLowerCase(), u.id);
    const st = {
      posts: 0, photos: 0, videos: 0, total: 0, unavailable: 0, partial: false,
      declared: u.edge_owner_to_timeline_media?.count ?? null,
    };
    const seen = new Set();
    let maxId = null, pages = 0;
    for (;;) {
      const d = await fetchUserFeed(username, u.id, maxId);
      for (const it of d.items || []) {
        const p = normalizePost(it);
        const key = p.id || p.code;
        if (seen.has(key)) continue;
        seen.add(key);
        st.posts++;
        for (const m of p.media) { if (m.type === 'video') st.videos++; else st.photos++; }
        st.unavailable += p.skipped;
      }
      st.total = st.photos + st.videos;
      say(`Counting… ${st.posts} posts, ${st.total} files`);
      if (!d.more_available || !d.next_max_id) break;
      if (++pages >= 200) { st.partial = true; break; }     // safety stop (~6,600 posts)
      maxId = d.next_max_id;
    }
    profileStats.set(username.toLowerCase(), st);
    return st;
  }

  function statsText(st) {
    let t = `Posts ${st.posts} · Photos ${st.photos} · Videos ${st.videos} · Total files ${st.total}`;
    if (st.declared != null && st.declared !== st.posts) t += ` · profile reports ${st.declared} posts`;
    if (st.unavailable) t += ` · ${st.unavailable} item(s) without a downloadable URL`;
    if (st.partial) t += ' · partial (safety limit)';
    return t;
  }

  function renderStats(username) {
    const el = barEl && barEl.querySelector('.ighd-stats');
    if (!el) return;
    const st = profileStats.get(username.toLowerCase());
    el.textContent = st ? statsText(st) : 'Press "Count contents" to see total photos / videos on this profile.';
  }

  async function runCount(username, statusEl) {
    if (profileBusy) return;
    profileBusy = true;
    barEl?.classList.add('ighd-busy');
    const say = (t) => { statusEl.textContent = t || ''; };
    try {
      await countProfile(username, say);
      say('');
      renderStats(username);
    } catch (e) {
      console.error('[IG HiRes Downloader]', e);
      say('');
      toast(e.message || 'Counting failed', { error: true });
    } finally {
      profileBusy = false;
      barEl?.classList.remove('ighd-busy');
    }
  }

  async function runProfileAction(username, action, statusEl) {
    if (profileBusy) return;
    profileBusy = true;
    barEl?.classList.add('ighd-busy');
    const say = (t) => { statusEl.textContent = t || ''; };
    try {
      const posts = await collectProfile(username, say);
      const items = flatten(posts, action);
      say('');
      const queued = await sendItems(items);
      if (queued) {
        const n = (k) => items.filter((i) => i.kind === k).length;
        say(`Queued ${queued}: ${n('image')} photos, ${n('video')} videos${n('audio') ? `, ${n('audio')} audio tracks` : ''}`);
      }
    } catch (e) {
      console.error('[IG HiRes Downloader]', e);
      say('');
      toast(e.message || 'Profile download failed', { error: true });
    } finally {
      profileBusy = false;
      barEl?.classList.remove('ighd-busy');
    }
  }

  function buildBar(username) {
    const status = h('span', { class: 'ighd-status', 'aria-live': 'polite' });
    const mk = (action, label) => h('button', {
      class: 'ighd-pbtn', type: 'button', onclick: () => runProfileAction(username, action, status),
    }, icon(ICON_DL), label);
    const countBtn = h('button', {
      class: 'ighd-pbtn', type: 'button', title: 'Scan the whole profile and count photos / videos',
      onclick: () => runCount(username, status),
    }, 'Count contents');
    const stats = h('div', { class: 'ighd-stats' });
    return h('div', { class: 'ighd-profile-bar', 'data-user': username },
      mk('images', 'Download all images'),
      mk('videos', 'Download all videos'),
      mk('all', 'Download the whole profile'),
      countBtn,
      status,
      stats);
  }

  function syncProfileBar() {
    const user = profileUsername();
    const header = user && document.querySelector('main header');
    if (!user || !header) {
      if (barEl) { barEl.remove(); barEl = null; }
      return;
    }
    if (barEl && barEl.isConnected && barEl.dataset.user === user && barEl.previousElementSibling === header) return;
    if (barEl) barEl.remove();
    barEl = buildBar(user);
    try { header.insertAdjacentElement('afterend', barEl); } catch (e) { console.warn('[IGHD] profile bar injection failed', e); }
    renderStats(user);
  }

  // =================================================================== lifecycle (SPA-safe)
  function tick() {
    const hosts = discoverHosts();
    const keys = new Set(hosts.map((x) => x.key));
    for (const [k, w] of widgets) {
      if (!keys.has(k) || (k instanceof Element && !k.isConnected)) { w.destroy(); widgets.delete(k); }
    }
    for (const hst of hosts) {
      const w = widgets.get(hst.key);
      if (w) w.host = hst; else widgets.set(hst.key, new Widget(hst));
    }
    reposition();
    syncProfileBar();
  }

  let rafId = 0, needFull = false;
  function schedule(full) {
    needFull = needFull || !!full;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const f = needFull; needFull = false;
      try { f ? tick() : reposition(); } catch (e) { console.error('[IGHD] tick error', e); }
    });
  }

  new MutationObserver((muts) => {
    if (muts.every((m) => root.contains(m.target))) return;   // ignore our own toast/widget churn
    schedule(true);
  }).observe(document.documentElement, { childList: true, subtree: true });

  addEventListener('scroll', () => schedule(!!profileUsername()), { capture: true, passive: true });
  addEventListener('resize', () => schedule(true), { passive: true });
  addEventListener('popstate', () => schedule(true));
  setInterval(() => schedule(true), 1500);                     // safety net for anything the observer misses
  schedule(true);
})();
