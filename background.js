/**
 * background.js — download orchestration.
 *
 *  - Receives lists of {url, kind, username, timestamp, id} from content.js.
 *  - Builds descriptive filenames:  Instagram/<user>/instagram_<user>_<timestamp>_<id>.<ext>
 *  - Runs a throttled queue (limited concurrency + staggered starts) so large bulk jobs
 *    don't freeze the browser or trip Instagram's CDN rate limits.
 *  - Waits for every download to actually complete, retries failures with exponential backoff.
 *  - Reports progress back to the originating tab and to the popup.
 *
 * Works in Chrome (service worker) and Firefox (event page) thanks to the `api` alias.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;

// ------------------------------------------------------------------ settings
const DEFAULTS = { concurrency: 3, organizeByUser: true, startDelayMs: 250 };
let settings = { ...DEFAULTS };
const settingsReady = api.storage.local.get(DEFAULTS)
  .then((s) => { settings = { ...DEFAULTS, ...s }; })
  .catch(() => {});
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const k of Object.keys(changes)) if (k in DEFAULTS) settings[k] = changes[k].newValue;
});

const MAX_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 180000;

// ------------------------------------------------------------------ state
const state = {
  queue: [],       // pending jobs
  active: 0,       // jobs currently downloading
  total: 0,
  done: 0,
  failed: 0,
  failures: [],    // {url, filename, error, job}
  tabs: new Set(), // tabs that want progress updates
};
const waiters = new Map(); // downloadId -> {resolve, reject}
let keepAlive = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers
function sanitize(s, max = 80) {
  const out = String(s ?? 'unknown')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, max);
  return out || 'unknown';
}

function extFromUrl(url, kind) {
  try {
    const e = new URL(url).pathname.split('.').pop().toLowerCase();
    if (/^(jpe?g|png|webp|heic|gif|mp4|mov|webm)$/.test(e)) return e === 'jpeg' ? 'jpg' : e;
  } catch (_) { /* fall through */ }
  return kind === 'video' ? 'mp4' : kind === 'audio' ? 'm4a' : 'jpg';
}

/** Only ever download from Instagram / Meta CDN hosts over https. */
function isAllowedUrl(u) {
  try {
    const { protocol, hostname } = new URL(u);
    return protocol === 'https:' &&
      /(^|\.)(cdninstagram\.com|fbcdn\.net|instagram\.com)$/.test(hostname);
  } catch (_) { return false; }
}

function buildFilename(it) {
  const user = sanitize(it.username, 40);
  const name = `instagram_${user}_${sanitize(it.timestamp, 32)}_${sanitize(it.id, 64)}.${it.ext || extFromUrl(it.url, it.kind)}`;
  return settings.organizeByUser ? `Instagram/${user}/${name}` : name;
}

function summary() {
  return {
    ok: true,
    total: state.total,
    done: state.done,
    failed: state.failed,
    active: state.active,
    queued: state.queue.length,
    failures: state.failures.slice(-20).map((f) => ({ filename: f.filename, error: f.error })),
  };
}

function broadcast() {
  const s = summary();
  const remaining = state.queue.length + state.active;
  try {
    api.action.setBadgeBackgroundColor({ color: '#0095f6' });
    api.action.setBadgeText({ text: remaining ? String(remaining) : '' });
  } catch (_) { /* badge is cosmetic */ }
  for (const tabId of state.tabs) {
    Promise.resolve(api.tabs.sendMessage(tabId, { type: 'DL_PROGRESS', status: s })).catch(() => state.tabs.delete(tabId));
  }
}

function startKeepAlive() {
  if (keepAlive) return;
  // Periodic extension-API call keeps the worker from being suspended mid-queue.
  keepAlive = setInterval(() => { Promise.resolve(api.runtime.getPlatformInfo()).catch(() => {}); }, 20000);
}
function stopKeepAlive() { if (keepAlive) { clearInterval(keepAlive); keepAlive = null; } }

// ------------------------------------------------------------------ queue
function enqueue(items, tabId) {
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'No items' };
  if (!state.queue.length && !state.active) {           // fresh batch → reset counters
    Object.assign(state, { total: 0, done: 0, failed: 0, failures: [] });
  }
  let queued = 0;
  const seen = new Set();
  for (const it of items) {
    if (!it || !isAllowedUrl(it.url) || seen.has(it.url)) continue;
    seen.add(it.url);
    state.queue.push({ url: it.url, filename: buildFilename(it), attempts: 0 });
    queued++;
  }
  if (!queued) return { ok: false, error: 'No valid media URLs' };
  state.total += queued;
  if (tabId != null) state.tabs.add(tabId);
  startKeepAlive();
  broadcast();
  pump();
  return { ok: true, queued };
}

function pump() {
  while (state.active < Math.max(1, settings.concurrency) && state.queue.length) {
    const job = state.queue.shift();
    state.active++;
    runJob(job).finally(() => {
      state.active--;
      broadcast();
      if (!state.active && !state.queue.length) stopKeepAlive();
      pump();
    });
  }
}

async function runJob(job) {
  await sleep(settings.startDelayMs);                    // stagger starts → gentle on the CDN
  try {
    const id = await api.downloads.download({
      url: job.url,
      filename: job.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    await waitForDownload(id);
    state.done++;
  } catch (err) {
    job.attempts++;
    const msg = String(err?.message || err);
    if (job.attempts < MAX_RETRIES) {
      await sleep(1000 * 2 ** job.attempts);             // 2s, 4s backoff
      state.queue.push(job);
    } else {
      state.failed++;
      state.failures.push({ filename: job.filename, error: msg, job });
    }
  }
}

function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      Promise.resolve(api.downloads.cancel(id)).catch(() => {});
      reject(new Error('timeout'));
    }, DOWNLOAD_TIMEOUT_MS);
    waiters.set(id, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    // The download may have already finished before the listener was registered.
    Promise.resolve(api.downloads.search({ id })).then((res) => {
      const d = res && res[0];
      const w = waiters.get(id);
      if (!d || !w) return;
      if (d.state === 'complete') { waiters.delete(id); w.resolve(); }
      else if (d.state === 'interrupted') { waiters.delete(id); w.reject(new Error(d.error || 'interrupted')); }
    }).catch(() => {});
  });
}

api.downloads.onChanged.addListener((delta) => {
  const w = waiters.get(delta.id);
  if (!w) return;
  if (delta.state?.current === 'complete') { waiters.delete(delta.id); w.resolve(); }
  else if (delta.state?.current === 'interrupted') {
    waiters.delete(delta.id);
    w.reject(new Error(delta.error?.current || 'interrupted'));
  }
});

// ------------------------------------------------------------------ messaging
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'ENQUEUE':
        await settingsReady;
        sendResponse(enqueue(msg.items, sender.tab?.id));
        break;
      case 'GET_STATUS':
        sendResponse(summary());
        break;
      case 'CANCEL': {
        const n = state.queue.length;
        state.queue = [];
        state.total -= n;
        broadcast();
        sendResponse({ ok: true, cancelled: n });
        break;
      }
      case 'RETRY_FAILED': {
        const jobs = state.failures.map((f) => f.job);
        state.failures = [];
        state.failed = 0;
        for (const j of jobs) { j.attempts = 0; state.queue.push(j); }
        state.total = state.done + state.queue.length + state.active;
        if (jobs.length) startKeepAlive();
        broadcast();
        pump();
        sendResponse({ ok: true, retried: jobs.length });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'Unknown message' });
    }
  })().catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // async response
});

api.tabs.onRemoved.addListener((tabId) => state.tabs.delete(tabId));
