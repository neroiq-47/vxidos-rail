const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {} }
};
const state = { token: store.get('rail.token'), reviewer: store.get('rail.reviewer'), status: 'pending_approval', bufferWrites: false };
const STATUS_LABEL = { pending_approval: 'pending', approved: 'approved', rejected: 'rejected', queuing: 'queuing', queued: 'queued' };
const REVIEWER_RE = /^[a-zA-Z0-9_-]{2,64}$/;

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid) n.append(kid);
  return n;
}

function toast(msg, error = false) {
  const t = el('div', { class: 'toast' + (error ? ' error' : ''), text: msg });
  $('toasts').append(t);
  setTimeout(() => t.remove(), error ? 7000 : 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${state.token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401) { signOut(); throw new Error('session expired — sign in again'); }
  if (res.status === 429) throw new Error('slow down — rate limited, try again shortly');
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

const chars = s => [...s].length;
function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  const units = [[86400, 'd'], [3600, 'h'], [60, 'm']];
  for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
}

function showAuth() {
  const authed = Boolean(state.token && state.reviewer);
  $('signin').hidden = authed;
  $('app').hidden = !authed;
  $('who').hidden = !authed;
  $('who-name').textContent = state.reviewer;
  if (authed) refresh(); else $('token').focus();
}

function signOut() {
  state.token = '';
  store.set('rail.token', '');
  showAuth();
}

async function refresh() {
  await Promise.all([loadStats(), loadDrafts(), loadEvents()].map(p => p.catch(e => toast(e.message, true))));
}

async function loadStats() {
  const { counts = {}, total = 0 } = await api('/stats');
  $('stats').replaceChildren(
    ...Object.entries(STATUS_LABEL).map(([k, label]) => el('span', { class: 'chip', text: label }, el('b', { text: String(counts[k] ?? 0) }))),
    el('span', { class: 'chip', text: 'total' }, el('b', { text: String(total) }))
  );
}

async function loadDrafts() {
  const box = $('drafts');
  box.setAttribute('aria-busy', 'true');
  const q = state.status ? `?status=${encodeURIComponent(state.status)}` : '';
  try {
    const { drafts = [] } = await api('/drafts' + q);
    box.replaceChildren(...(drafts.length ? drafts.map(card) : [el('p', { class: 'empty', text: 'nothing here. quiet night.' })]));
  } finally { box.setAttribute('aria-busy', 'false'); }
}

async function loadEvents() {
  const { events = [] } = await api('/events?limit=50');
  $('events').replaceChildren(...events.map(e => el('li', {},
    el('span', { text: `${ago(e.at)} · ` }), el('b', { text: e.type.replace(/_/g, ' ') }),
    el('span', { text: ` ${String(e.id || '').slice(0, 8)}${e.reviewer ? ' · ' + e.reviewer : ''}` }))));
}

async function act(btn, fn, okMsg) {
  const card = btn.closest('.card');
  card?.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); }
  catch (e) { toast(e.message, true); card?.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
}

function countEl(text) {
  const n = chars(text);
  return el('span', { class: 'count mono' + (n > 280 ? ' over' : ''), text: `${n}/280` });
}

function card(d) {
  const meta = el('div', { class: 'meta' },
    el('span', { class: `badge ${d.status}`, text: STATUS_LABEL[d.status] || d.status }),
    d.pillar ? el('span', { class: 'tag', text: d.pillar }) : null,
    el('span', { text: ago(d.createdAt), title: d.createdAt }),
    countEl(d.text),
    d.reviewedBy ? el('span', { text: `by ${d.reviewedBy}` }) : null,
    d.bufferPostId ? el('span', { class: 'mono', text: `buffer ${d.bufferPostId}` }) : null);
  const c = el('article', { class: 'card', 'data-id': d.id }, el('p', { class: 'text', text: d.text }), meta);
  if (d.note) c.append(el('p', { class: 'note dim', text: `note: ${d.note}` }));
  if (d.queueError) c.append(el('p', { class: 'err', text: `buffer error: ${d.queueError}` }));
  const actions = el('div', { class: 'actions' });
  const id = encodeURIComponent(d.id);

  if (d.status === 'pending_approval') {
    actions.append(
      el('button', { type: 'button', class: 'ok', onclick: e => act(e.currentTarget, () =>
        api(`/drafts/${id}/review`, { method: 'POST', body: { decision: 'approved', reviewer: state.reviewer } }), 'approved') }, 'approve'),
      el('button', { type: 'button', onclick: () => editMode(c, d) }, 'edit'),
      el('button', { type: 'button', class: 'bad', onclick: () => rejectMode(c, d) }, 'reject'));
  } else if (d.status === 'approved') {
    const b = el('button', { type: 'button', class: 'primary', disabled: !state.bufferWrites, onclick: e => act(e.currentTarget, () =>
      api(`/drafts/${id}/queue`, { method: 'POST', body: { reviewer: state.reviewer } }), 'sent to buffer as draft') }, 'send to buffer');
    actions.append(b);
    if (!state.bufferWrites) {
      b.setAttribute('aria-describedby', `hint-${d.id}`);
      actions.append(el('span', { class: 'hint', id: `hint-${d.id}`, text: 'buffer writes disabled on server' }));
    }
  }
  if (actions.childNodes.length) c.append(actions);
  return c;
}

function editMode(c, d) {
  const ta = el('textarea', { 'aria-label': 'edit draft text', maxlength: 600 });
  ta.value = d.text;
  const cnt = countEl(d.text);
  ta.addEventListener('input', () => { const n = countEl(ta.value); c.querySelector('.edit-count').replaceChildren(n); });
  const save = el('button', { type: 'button', class: 'primary', onclick: e => act(e.currentTarget, () =>
    api(`/drafts/${encodeURIComponent(d.id)}`, { method: 'PATCH', body: { text: ta.value, editor: state.reviewer } }), 'saved') }, 'save');
  const cancel = el('button', { type: 'button', class: 'ghost', onclick: () => c.replaceWith(card(d)) }, 'cancel');
  c.replaceChildren(ta, el('div', { class: 'meta' }, el('span', { class: 'edit-count' }, cnt)), el('div', { class: 'actions' }, save, cancel));
  ta.focus();
}

function rejectMode(c, d) {
  const note = el('input', { type: 'text', maxlength: 280, placeholder: 'note (optional)', 'aria-label': 'rejection note' });
  const confirm = el('button', { type: 'button', class: 'bad', onclick: e => act(e.currentTarget, () =>
    api(`/drafts/${encodeURIComponent(d.id)}/review`, { method: 'POST',
      body: { decision: 'rejected', reviewer: state.reviewer, ...(note.value.trim() ? { note: note.value.trim() } : {}) } }), 'rejected') }, 'confirm reject');
  const cancel = el('button', { type: 'button', class: 'ghost', onclick: () => c.replaceWith(card(d)) }, 'cancel');
  note.addEventListener('keydown', e => { if (e.key === 'Enter') confirm.click(); if (e.key === 'Escape') cancel.click(); });
  c.querySelector('.actions').replaceChildren(note, confirm, cancel);
  note.focus();
}

async function generate() {
  const btn = $('gen-btn');
  btn.disabled = true; btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true');
  try {
    const pillar = $('gen-pillar').value;
    const { drafts = [], errors = [] } = await api('/draft', { method: 'POST', body: { count: Number($('gen-count').value), ...(pillar ? { pillar } : {}) } });
    toast(`${drafts.length} draft${drafts.length === 1 ? '' : 's'} generated`);
    errors.forEach(e => toast(e, true));
    if (state.status !== 'pending_approval' && state.status !== '') selectTab('pending_approval');
    await refresh();
  } catch (e) { toast(e.message, true); }
  finally { btn.disabled = false; btn.classList.remove('busy'); btn.removeAttribute('aria-busy'); }
}

function selectTab(status) {
  state.status = status;
  document.querySelectorAll('.tabs [role=tab]').forEach(t => t.setAttribute('aria-selected', String(t.dataset.status === status)));
}

$('signin-form').addEventListener('submit', e => {
  e.preventDefault();
  const token = $('token').value.trim(), reviewer = $('reviewer').value.trim();
  if (token.length < 24) return toast('token must be at least 24 characters', true);
  if (!REVIEWER_RE.test(reviewer)) return toast('reviewer: 2-64 letters, digits, _ or -', true);
  Object.assign(state, { token, reviewer });
  store.set('rail.token', token); store.set('rail.reviewer', reviewer);
  $('token').value = '';
  showAuth();
});
$('signout').addEventListener('click', signOut);
$('gen-btn').addEventListener('click', generate);
document.querySelector('.tabs').addEventListener('click', e => {
  const t = e.target.closest('[role=tab]');
  if (!t) return;
  selectTab(t.dataset.status);
  loadDrafts().catch(err => toast(err.message, true));
});
$('reviewer').value = state.reviewer;

fetch('/health').then(r => r.json()).then(h => {
  state.bufferWrites = Boolean(h.bufferWrites);
  $('foot').textContent = `${String(h.brand || 'vxidos').toLowerCase()} rail ${h.version ? 'v' + h.version : ''} · buffer writes ${state.bufferWrites ? 'on' : 'off'}`;
}).catch(() => { $('foot').textContent = 'server unreachable'; }).finally(showAuth);
