/**
 * inject.js — runs in the PAGE's own JavaScript world (manifest: "world": "MAIN").
 *
 * Purpose: passively "sniff" the JSON Instagram's own web app receives (fetch + XHR +
 * the JSON blobs embedded in the initial HTML), pull out every media object that carries
 * image_versions2 / video_versions, and forward a slimmed-down copy to content.js via
 * window.postMessage. This is how we obtain the full-resolution CDN URLs without
 * needing chrome.debugger (which shows an intrusive "debugging this browser" banner).
 *
 * It never modifies responses and never makes requests of its own.
 */
(() => {
  'use strict';
  if (window.__ighdInject) return;
  Object.defineProperty(window, '__ighdInject', { value: true });

  const TAG = 'IGHD';
  const send = (type, payload = {}) => {
    try { window.postMessage({ source: TAG, type, ...payload }, location.origin); } catch (_) { /* ignore */ }
  };

  // ---------------------------------------------------------------- slimming
  const userOf = (n) => {
    const u = n.user || n.owner;
    return u ? { pk: String(u.pk || u.id || ''), username: u.username || null } : null;
  };

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

  /** Keep only what we need so postMessage stays cheap. */
  const slim = (n) => ({
    pk: String(n.pk || n.id || '').split('_')[0],
    code: n.code || n.shortcode || null,
    media_type: n.media_type ?? null, // 1 image, 2 video, 8 carousel
    taken_at: n.taken_at || n.taken_at_timestamp || null,
    user: userOf(n),
    image_versions2: {
      candidates: (n.image_versions2?.candidates || []).slice(0, 8)
        .map((c) => ({ url: c.url, width: c.width, height: c.height })),
    },
    video_versions: (n.video_versions || []).slice(0, 6)
      .map((v) => ({ url: v.url, width: v.width, height: v.height, type: v.type })),
    dash: parseDash(n.video_dash_manifest),
    carousel_media: Array.isArray(n.carousel_media) ? n.carousel_media.map(slim) : undefined,
  });

  const looksLikeMedia = (n) =>
    (n.image_versions2 || n.video_versions) && (n.code || n.shortcode || n.pk || n.id);

  /** Depth-limited walk. Stops descending once a media node is found (children handled by slim). */
  function walk(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, out, depth + 1); return; }
    if (looksLikeMedia(node)) { out.push(slim(node)); return; }
    for (const k in node) {
      const v = node[k];
      if (v && typeof v === 'object') walk(v, out, depth + 1);
    }
  }

  function handleText(text) {
    if (!text || text.length < 20) return;
    if (text.indexOf('image_versions2') === -1 && text.indexOf('video_versions') === -1) return;
    const body = text.replace(/^for \(;;\);/, '');
    const out = [];
    try {
      walk(JSON.parse(body), out);
    } catch (_) {
      // Some GraphQL endpoints return newline-delimited JSON.
      for (const line of body.split('\n')) {
        if (line.length > 20) { try { walk(JSON.parse(line), out); } catch (__) { /* skip */ } }
      }
    }
    if (out.length) send('ITEMS', { items: out });
  }

  // ---------------------------------------------------------------- fetch hook
  const wanted = (u) => typeof u === 'string' && /\/api\/v1\/|\/graphql|\/api\/graphql/.test(u);

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      if (wanted(url)) p.then((res) => res.clone().text()).then(handleText).catch(() => {});
    } catch (_) { /* never break the page */ }
    return p;
  };

  // ---------------------------------------------------------------- XHR hook
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__ighdUrl = String(url); } catch (_) { /* ignore */ }
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (wanted(this.__ighdUrl)) {
        this.addEventListener('load', () => {
          try { if (!this.responseType || this.responseType === 'text') handleText(this.responseText); } catch (_) { /* ignore */ }
        });
      }
    } catch (_) { /* ignore */ }
    return xhrSend.apply(this, arguments);
  };

  // ---------------------------------------------------------------- inline JSON (first page load)
  function scanInline() {
    document.querySelectorAll('script[type="application/json"]').forEach((s) => {
      if (s.__ighd) return;
      s.__ighd = 1;
      handleText(s.textContent);
    });
  }
  document.addEventListener('DOMContentLoaded', scanInline);
  window.addEventListener('load', scanInline);

  // ---------------------------------------------------------------- SPA navigation signal
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m];
    history[m] = function () {
      const r = orig.apply(this, arguments);
      send('NAV');
      return r;
    };
  }
  window.addEventListener('popstate', () => send('NAV'));
})();
