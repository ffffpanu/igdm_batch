'use strict';
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

const DEFAULTS = { videoMode: 'progressive', profileScope: 'loaded', maxPosts: 100, concurrency: 3, organizeByUser: true };

async function refresh() {
  try {
    const s = await api.runtime.sendMessage({ type: 'GET_STATUS' });
    if (!s?.ok) return;
    $('done').textContent = s.done;
    $('active').textContent = s.active;
    $('queued').textContent = s.queued;
    $('failed').textContent = s.failed;
    const ul = $('errors');
    ul.textContent = '';
    for (const f of s.failures) {
      const li = document.createElement('li');
      li.textContent = `${f.filename.split('/').pop()} — ${f.error}`;
      ul.append(li);
    }
  } catch (_) { /* background asleep; next poll wakes it */ }
}

async function loadSettings() {
  const s = await api.storage.local.get(DEFAULTS);
  $('profileScope').value = s.profileScope;
  $('videoMode').value = s.videoMode;
  $('maxPosts').value = s.maxPosts;
  $('concurrency').value = s.concurrency;
  $('organizeByUser').checked = !!s.organizeByUser;
}

function bindSetting(id, read) {
  $(id).addEventListener('change', () => api.storage.local.set({ [id]: read($(id)) }));
}
bindSetting('profileScope', (el) => el.value);
bindSetting('videoMode', (el) => el.value);
bindSetting('maxPosts', (el) => Math.min(2000, Math.max(1, parseInt(el.value, 10) || 100)));
bindSetting('concurrency', (el) => Math.min(6, Math.max(1, parseInt(el.value, 10) || 3)));
bindSetting('organizeByUser', (el) => el.checked);

$('cancel').addEventListener('click', async () => { await api.runtime.sendMessage({ type: 'CANCEL' }); refresh(); });
$('retry').addEventListener('click', async () => { await api.runtime.sendMessage({ type: 'RETRY_FAILED' }); refresh(); });

loadSettings();
refresh();
setInterval(refresh, 1000);
