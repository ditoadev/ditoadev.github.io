import { CaptureEngine, MODELS, detectGpu, canShareAudio } from './capture.js';
import * as store from './store.js';
import { makeNotes, buildContext, chat, speakerName, MODELS as AI_MODELS } from './ai.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
const isPhone = () => /Android|iPhone|iPad/i.test(navigator.userAgent) || matchMedia('(max-width: 760px)').matches;
function status(id, text, kind) { const el = $(id); if (!el) return; el.textContent = text || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }
function dayLabel(t) {
  const d = new Date(t), today = new Date(); today.setHours(0, 0, 0, 0);
  const dd = new Date(d); dd.setHours(0, 0, 0, 0);
  const diff = Math.round((today - dd) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
function chipClass(who) {
  if (who === 'You') return 'you';
  if (who === 'Call') return 'call';
  const n = parseInt(who.slice(1), 10) || 1;
  return 's' + (((n - 1) % 6) + 1);
}

// ---------------- Settings & state ----------------
let settings = { ownerName: '', gh: { owner: '', repo: '', token: '' }, passphrase: '', apiKey: '', autoNotes: true, aiModel: 'haiku' };
let episodes = [];
let sync = null;
const saveSettings = () => store.kvSet('settings', settings);
async function reloadEpisodes() { episodes = (await store.allEpisodes()).filter((e) => !e.deleted); return episodes; }
const syncConfigured = () => !!(settings.gh.owner && settings.gh.repo && settings.gh.token && settings.passphrase);

// ---------------- Routing ----------------
const VIEWS = ['ask', 'timeline', 'capture', 'settings'];
function route() {
  let v = location.hash.slice(1);
  if (!VIEWS.includes(v)) v = isPhone() ? 'ask' : 'capture';
  for (const name of VIEWS) $('v-' + name).hidden = name !== v;
  document.querySelectorAll('.tabs a').forEach((a) => { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (v === 'timeline') renderTimeline();
  if (v === 'ask') renderChat();
  $('main').scrollTop = 0;
}
addEventListener('hashchange', route);

// ---------------- Sync ----------------
let syncTimer = null;
function setPill(kind, text) { const p = $('syncPill'); p.className = 'syncpill ' + (kind || ''); $('syncText').textContent = text; }
async function runSync(reason) {
  if (!syncConfigured()) { setPill('', 'sync off'); return; }
  if (!navigator.onLine) { setPill('err', 'offline'); return; }
  sync = sync || new store.Sync({ ...settings.gh, passphrase: settings.passphrase });
  setPill('busy', 'syncing…');
  try {
    const r = await sync.sync((t) => setPill('busy', t));
    setPill('ok', 'synced ' + hhmm(Date.now()));
    if (r.down || r.up) { await reloadEpisodes(); refreshVisible(); }
    status('syncStatus', `Synced. ${r.down} downloaded, ${r.up} uploaded.`, 'ok');
    queueNotes();
  } catch (e) {
    setPill('err', 'sync failed');
    status('syncStatus', e.message + (e instanceof TypeError ? ' This network may block api.github.com: use the backup file instead.' : ''), 'err');
  }
}
function syncSoon() { clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync('change'), 2500); }
$('syncPill').addEventListener('click', () => { if (syncConfigured()) runSync('manual'); else location.hash = '#settings'; });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') runSync('focus'); });
setInterval(() => runSync('interval'), 5 * 60 * 1000);

function refreshVisible() {
  if (!$('v-timeline').hidden) renderTimeline();
  if (!$('v-ask').hidden) updateCtxLine();
}

// ---------------- Notes (Claude) ----------------
let notesBusy = false;
async function queueNotes() {
  if (notesBusy || !settings.apiKey || !settings.autoNotes) return;
  const todo = episodes.filter((e) => !e.notes && !e.notesError && e.lines?.length >= 3 && e.id !== cap.ep?.id);
  if (!todo.length) return;
  notesBusy = true;
  try {
    for (const ep of todo) { await notesFor(ep); }
  } finally { notesBusy = false; }
}
async function notesFor(ep) {
  status('notesStatus', `Making notes for "${ep.notes?.title || ep.title}"…`);
  try {
    const topics = [...new Set(episodes.flatMap((e) => e.notes?.topics || []))].slice(0, 40);
    ep.notes = await makeNotes(settings.apiKey, ep, { ownerName: settings.ownerName, knownTopics: topics, model: settings.aiModel });
    delete ep.notesError;
    await store.saveEpisode(ep);
    status('notesStatus', '');
    chatContext = null;
    refreshVisible(); syncSoon();
  } catch (e) {
    ep.notesError = e.message; await store.putEpisodeRaw(ep);
    status('notesStatus', e.message, 'err');
    refreshVisible();
  }
}

// ---------------- Timeline ----------------
const open = new Set();
let confirmDelete = null;
function epText(ep) {
  return [ep.title, ep.notes?.title, ep.notes?.summary, ...(ep.notes?.people || []), ...(ep.notes?.topics || []), ...Object.values(ep.names || {}), ...ep.lines.map((l) => l.text)].join(' ').toLowerCase();
}
function renderTimeline() {
  const q = $('search').value.trim().toLowerCase();
  const list = episodes.filter((e) => !q || q.split(/\s+/).every((w) => epText(e).includes(w))).sort((a, b) => b.start - a.start);
  // Open promises (mine, not done)
  const mine = [];
  for (const e of episodes) (e.notes?.promises || []).forEach((p, i) => { if (p.mine && !(e.done || {})[i]) mine.push({ e, p, i }); });
  $('openPromises').hidden = !mine.length;
  $('promiseList').innerHTML = mine.slice(0, 12).map(({ e, p, i }) => promiseHtml(e, p, i)).join('');

  const box = $('timelineList');
  if (!episodes.length) {
    box.innerHTML = `<div class="empty"><h3>No conversations yet</h3><p>Capture a call on your laptop, or import a transcript file.${syncConfigured() ? '' : ' To see your laptop\'s calls here, set up sync in Settings on both devices.'}</p></div>`;
    return;
  }
  if (!list.length) { box.innerHTML = `<div class="empty"><p>Nothing matches "${esc(q)}".</p></div>`; return; }
  let html = '', lastDay = '';
  for (const e of list) {
    const d = dayLabel(e.start);
    if (d !== lastDay) { html += `<div class="dayhead">${esc(d)}</div>`; lastDay = d; }
    html += epHtml(e);
  }
  box.innerHTML = html;
}
function promiseHtml(e, p, i) {
  const done = !!(e.done || {})[i];
  return `<label class="promise${done ? ' done' : ''}"><input type="checkbox" data-done="${e.id}:${i}"${done ? ' checked' : ''}><span>${esc(p.what)}<small>${esc(p.who)}${p.due ? ' · due ' + esc(p.due) : ''} · ${esc(e.notes?.title || e.title)}</small></span></label>`;
}
function epHtml(e) {
  const n = e.notes, isOpen = open.has(e.id);
  const speakers = new Set(e.lines.map((l) => l.who)).size;
  const meta = `${hhmm(e.start)}–${hhmm(e.end || e.start)} · ${speakers} voice${speakers === 1 ? '' : 's'} · ${e.lines.length} lines${e.source ? ' · ' + e.source : ''}`;
  let body = '';
  if (isOpen) {
    const list = (title, arr) => arr?.length ? `<div><h4>${title}</h4><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '';
    body = `<div class="ep-body">
      ${n ? `${list('Decisions', n.decisions)}
      ${n.promises.length ? `<div><h4>Promises</h4><div class="promises">${n.promises.map((p, i) => promiseHtml(e, p, i)).join('')}</div></div>` : ''}
      ${list('Open questions', n.open_questions)}
      ${n.people.length ? `<div><h4>People</h4><p class="small">${esc(n.people.join(', '))}</p></div>` : ''}
      ${n.topics.length ? `<div class="row">${n.topics.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}`
      : `<p class="small muted">${e.notesError ? esc(e.notesError) : settings.apiKey ? 'No notes yet.' : 'Add a Claude API key in Settings to get notes, decisions and promises.'}</p>`}
      <div><h4>Transcript</h4><div class="tx">${e.lines.map((l) => `<div class="l"><span class="tm">${hhmm(l.t)}</span><button class="chip ${chipClass(l.who)}" data-name="${e.id}:${esc(l.who)}">${esc(speakerName(e, l.who, ''))}</button><span>${esc(l.text)}</span></div>`).join('')}</div></div>
      <div class="row">
        ${settings.apiKey ? `<button class="btn sm" data-notes="${e.id}">${n ? 'Redo notes' : 'Make notes'}</button>` : ''}
        <button class="btn sm danger" data-del="${e.id}">${confirmDelete === e.id ? 'Tap again to delete' : 'Delete'}</button>
      </div>
    </div>`;
  }
  return `<article class="card ep" id="ep-${e.id}">
    <button class="ep-head" data-open="${e.id}" aria-expanded="${isOpen}"><span class="t">${esc(n?.title || e.title)}</span><span class="m">${esc(meta)}</span></button>
    ${n ? `<p class="ep-sum">${esc(n.summary)}</p>` : ''}
    ${body}
  </article>`;
}
$('search').addEventListener('input', renderTimeline);
$('v-timeline').addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-open],[data-notes],[data-del],[data-name]');
  if (!t) return;
  if (t.dataset.open) { const id = t.dataset.open; open.has(id) ? open.delete(id) : open.add(id); confirmDelete = null; renderTimeline(); return; }
  if (t.dataset.notes) { const ep = episodes.find((e) => e.id === t.dataset.notes); if (ep) { delete ep.notesError; t.disabled = true; t.textContent = 'Working…'; await notesFor(ep); } return; }
  if (t.dataset.del) {
    const id = t.dataset.del;
    if (confirmDelete !== id) { confirmDelete = id; renderTimeline(); return; }
    const ep = episodes.find((e) => e.id === id);
    // Keep a tombstone so the deletion syncs to other devices.
    Object.assign(ep, { deleted: true, lines: [], notes: null, names: {}, title: '(deleted)' });
    await store.saveEpisode(ep); confirmDelete = null; chatContext = null;
    await reloadEpisodes(); renderTimeline(); syncSoon(); return;
  }
  if (t.dataset.name) {
    const [id, who] = splitOnce(t.dataset.name);
    const ep = episodes.find((e) => e.id === id); if (!ep || who === 'You') return;
    const n = prompt(`Name for ${speakerName(ep, who, '')} in this conversation:`, (ep.names || {})[who] || '');
    if (n === null) return;
    ep.names = ep.names || {}; if (n.trim()) ep.names[who] = n.trim(); else delete ep.names[who];
    await store.saveEpisode(ep); chatContext = null; renderTimeline(); syncSoon();
  }
});
document.addEventListener('change', async (ev) => {
  const c = ev.target.closest('[data-done]'); if (!c) return;
  const [id, i] = splitOnce(c.dataset.done);
  const ep = episodes.find((e) => e.id === id); if (!ep) return;
  ep.done = ep.done || {}; ep.done[i] = c.checked;
  await store.saveEpisode(ep); renderTimeline(); syncSoon();
});
function splitOnce(s) { const k = s.indexOf(':'); return [s.slice(0, k), s.slice(k + 1)]; }

$('importFile').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  try {
    const { lines, names, title } = store.parseTranscript(await f.text(), f.name, new Date(f.lastModified));
    const start = lines[0].t;
    const ep = { id: store.newId(new Date(start)), start, end: lines[lines.length - 1].end || lines[lines.length - 1].t, source: 'imported', title: title || 'Imported conversation', lines, names };
    await store.saveEpisode(ep); await reloadEpisodes(); chatContext = null;
    open.add(ep.id); renderTimeline(); syncSoon(); queueNotes();
    status('notesStatus', `Imported ${lines.length} lines from ${f.name}.`, 'ok');
  } catch (e) { status('notesStatus', e.message, 'err'); }
});

// ---------------- Ask ----------------
let history = [];
let chatContext = null;
let chatBusy = false;
const SUGGESTIONS = ['What did I promise recently?', 'Summarize my last meeting', 'What decisions were made this week?', 'What is still open, and with whom?'];
function updateCtxLine() {
  const n = episodes.filter((e) => e.lines?.length).length;
  if (!n) { $('ctxLine').textContent = ''; return; }
  const c = chatContext || buildContext(episodes, { ownerName: settings.ownerName, model: settings.aiModel });
  const price = c.cost < 0.01 ? 'under $0.01' : '~$' + c.cost.toFixed(2);
  $('ctxLine').textContent = `${c.episodes} conversations · ${c.transcripts} in full · ~${Math.round(c.tokens / 1000)}k tokens · ${price} per new chat`;
}
function renderChat() {
  const box = $('msgs');
  if (!history.length) {
    const n = episodes.filter((e) => e.lines?.length).length;
    box.innerHTML = `<div class="empty">${!settings.apiKey
      ? `<h3>Add your Claude API key</h3><p>Chat needs a key from console.anthropic.com. It stays on this phone.</p><a class="btn primary" href="#settings">Open Settings</a>`
      : !n ? `<h3>No conversations yet</h3><p>${syncConfigured() ? 'Calls captured on your laptop appear here after they sync.' : 'Set up sync in Settings so calls captured on your laptop reach this device.'}</p>`
      : `<h3>Ask about your conversations</h3><p>${n} conversation${n === 1 ? '' : 's'} available. Answers link back to the conversation they came from.</p>`}</div>`;
  } else box.innerHTML = history.map((m) => msgHtml(m)).join('');
  $('suggest').innerHTML = history.length || !settings.apiKey ? '' : SUGGESTIONS.map((s) => `<button type="button" data-q="${esc(s)}">${esc(s)}</button>`).join('');
  updateCtxLine();
  scrollChat();
}
function msgHtml(m) {
  if (m.role === 'user') return `<div class="msg user">${esc(m.text).replace(/\n/g, '<br>')}</div>`;
  if (m.error) return `<div class="msg assistant err">${esc(m.error)}</div>`;
  return `<div class="msg assistant${m.streaming ? ' typing' : ''}">${md(m.text)}</div>`;
}
function md(text) {
  const epTitle = (id) => { const e = episodes.find((x) => x.id === id); if (!e) return 'source'; const t = e.notes?.title || e.title; return `${hhmm(e.start)} ${t.length > 34 ? t.slice(0, 33).trimEnd() + '…' : t}`; };
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[\[ep:([\w-]+)\]\]/g, (_, id) => `<button class="cite" data-ep="${id}">${esc(epTitle(id))}</button>`);
  const out = []; let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (li) { if (!list) { list = []; } list.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    out.push(h ? `<p><b>${inline(h[1])}</b></p>` : `<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}
function scrollChat() { const m = $('main'); requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; }); }
async function ask(q) {
  if (chatBusy || !q.trim()) return;
  if (!settings.apiKey) { location.hash = '#settings'; return; }
  chatBusy = true; $('askBtn').disabled = true;
  history.push({ role: 'user', text: q.trim() });
  const a = { role: 'assistant', text: '', streaming: true };
  history.push(a); renderChat();
  if (!chatContext) chatContext = buildContext(episodes, { ownerName: settings.ownerName, model: settings.aiModel });
  const turns = history.filter((m) => !m.error && m !== a).map((m) => ({ role: m.role, text: m.text }));
  let raf = 0;
  try {
    await chat(settings.apiKey, chatContext.text, turns, (d) => {
      a.text += d;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; const last = $('msgs').lastElementChild; if (last) { last.innerHTML = md(a.text); scrollChat(); } });
    }, settings.aiModel);
    a.streaming = false;
  } catch (e) {
    a.streaming = false; a.error = e.message;
    history.splice(history.length - 2, 1); // drop the failed question from the conversation sent next time
  }
  chatBusy = false; $('askBtn').disabled = false; renderChat();
}
$('askForm').addEventListener('submit', (e) => { e.preventDefault(); const q = $('askInput').value; $('askInput').value = ''; autosize(); ask(q); });
$('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !isPhone()) { e.preventDefault(); $('askForm').requestSubmit(); } });
function autosize() { const t = $('askInput'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; }
$('askInput').addEventListener('input', autosize);
$('suggest').addEventListener('click', (e) => { const b = e.target.closest('[data-q]'); if (b) ask(b.dataset.q); });
$('newChat').addEventListener('click', () => { history = []; chatContext = null; renderChat(); });
$('msgs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-ep]'); if (!c) return;
  open.add(c.dataset.ep); location.hash = '#timeline';
  setTimeout(() => $('ep-' + c.dataset.ep)?.scrollIntoView({ block: 'start' }), 50);
});

// ---------------- Capture ----------------
const cap = { engine: null, ep: null, saveTimer: null, liveNames: {} };
cap.engine = new CaptureEngine({
  onStatus: (t, kind, frac) => { status('loadStatus', t); if (frac != null) $('loadBar').style.width = (frac * 100).toFixed(1) + '%'; },
  onLevel: (who, v) => { $(who === 'You' ? 'micLvl' : 'callLvl').style.width = (v * 100).toFixed(0) + '%'; },
  onStats: (s) => {
    Object.assign(cap.stats = cap.stats || {}, s);
    const x = cap.stats;
    $('capStats').innerHTML = [x.speed ? `${x.speed.toFixed(1)}× real time` : '', x.audio ? `${x.audio.toFixed(0)} s transcribed` : '', `queue ${x.queue || 0}`, x.speakers ? `${x.speakers} call voices` : ''].filter(Boolean).map((s) => `<span>${s}</span>`).join('');
  },
  onLine: (l) => addLiveLine(l),
});

(async function initCapture() {
  if (!canShareAudio()) { $('callBtn').hidden = true; $('shareHint').hidden = true; $('callMeter').hidden = true; $('capNote').textContent = 'On a phone you can record a conversation with the microphone while the screen stays on. Calls on your laptop are captured from the browser there.'; }
  const g = await detectGpu();
  $('gpuInfo').textContent = g.ok ? 'GPU: ' + g.name : 'No suitable GPU, using CPU';
  if (!g.ok) $('model').value = isPhone() ? 'tiny-cpu' : 'base-cpu';
  $('model').querySelectorAll('option').forEach((o) => { const m = MODELS[o.value]; if ((m.gpu && !g.ok) || (m.f16 && !g.f16)) o.disabled = true; });
})();

$('loadBtn').addEventListener('click', async () => {
  $('loadBtn').disabled = true;
  cap.engine.language = $('lang').value;
  try {
    const label = await cap.engine.load($('model').value, { diarize: $('diar').checked, speakerMatch: +$('spk').value });
    status('loadStatus', 'Ready · ' + label, 'ok'); $('loadBar').style.width = '100%';
    $('micBtn').disabled = false; $('callBtn').disabled = false;
  } catch (e) { status('loadStatus', e.message, 'err'); }
  $('loadBtn').disabled = false;
});
$('lang').addEventListener('change', () => { cap.engine.language = $('lang').value; });
$('thr').addEventListener('input', () => { cap.engine.vadThreshold = +$('thr').value; });
$('spk').addEventListener('change', () => cap.engine.setSpeakerMatch(+$('spk').value));

$('micBtn').addEventListener('click', async () => {
  if (cap.engine.mic) { cap.engine.stopMic(); $('micBtn').textContent = 'Start microphone'; $('micState').textContent = 'off'; updateFinish(); return; }
  try {
    const label = await cap.engine.startMic();
    $('micBtn').textContent = 'Stop microphone'; $('micState').textContent = 'live';
    status('capStatus', 'Listening on ' + label, 'ok'); ensureEpisode(cap.engine.call ? 'call' : 'in person');
  } catch (e) { status('capStatus', 'Microphone blocked: ' + e.name + '. Allow microphone access for this site.', 'err'); }
  updateFinish();
});
$('callBtn').addEventListener('click', async () => {
  if (cap.engine.call) { cap.engine.stopCall(); callStopped(); return; }
  try {
    const what = await cap.engine.startCall(callStopped);
    $('callBtn').textContent = 'Stop sharing'; $('callState').textContent = 'live';
    status('capStatus', 'Capturing ' + what + '.', 'ok'); ensureEpisode('call'); if (cap.ep) cap.ep.source = 'call';
  } catch (e) {
    status('capStatus', e.name === 'NotAllowedError' ? 'Sharing was cancelled or blocked by policy.' : e.message, 'err');
  }
  updateFinish();
});
function callStopped() { $('callBtn').textContent = 'Share call audio'; $('callState').textContent = 'off'; updateFinish(); }
function updateFinish() { $('finishBtn').disabled = !(cap.ep || cap.engine.capturing); }

function ensureEpisode(source) {
  if (cap.ep) return cap.ep;
  const now = new Date();
  cap.ep = { id: store.newId(now), start: now.getTime(), end: now.getTime(), source, title: `${source === 'call' ? 'Call' : 'Conversation'} at ${hhmm(now)}`, lines: [], names: {} };
  cap.engine.resetSpeakers();
  $('live').innerHTML = ''; $('liveTitle').textContent = cap.ep.title;
  updateFinish();
  return cap.ep;
}
function addLiveLine(l) {
  const ep = ensureEpisode(cap.engine.call ? 'call' : 'in person');
  const last = ep.lines[ep.lines.length - 1];
  if (last && last.who === l.who && l.t - last.end < 2000 && !/[.?!]["')]?$/.test(last.text)) {
    last.text += ' ' + l.text; last.end = l.end.getTime();
    const el = $('live').lastElementChild?.querySelector('.txt'); if (el) el.textContent = last.text;
  } else {
    ep.lines.push({ t: l.t.getTime(), end: l.end.getTime(), who: l.who, text: l.text });
    const row = document.createElement('div'); row.className = 'l';
    row.innerHTML = `<span class="tm">${hhmmss(l.t)}</span><button class="chip ${chipClass(l.who)}" data-who="${l.who}">${esc(speakerName(ep, l.who, ''))}</button><span class="txt"></span>`;
    row.querySelector('.txt').textContent = l.text;
    const box = $('live'), atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.appendChild(row); if (atEnd) box.scrollTop = box.scrollHeight;
  }
  ep.end = l.end.getTime();
  clearTimeout(cap.saveTimer); cap.saveTimer = setTimeout(() => store.saveEpisode(ep), 15000);
}
$('live').addEventListener('click', (e) => {
  const c = e.target.closest('[data-who]'); if (!c || !cap.ep || c.dataset.who === 'You') return;
  const who = c.dataset.who, n = prompt(`Name for ${speakerName(cap.ep, who, '')}:`, cap.ep.names[who] || '');
  if (n === null) return;
  if (n.trim()) cap.ep.names[who] = n.trim(); else delete cap.ep.names[who];
  document.querySelectorAll(`#live [data-who="${CSS.escape(who)}"]`).forEach((x) => { x.textContent = speakerName(cap.ep, who, ''); });
});
$('finishBtn').addEventListener('click', async () => {
  $('finishBtn').disabled = true;
  cap.engine.stopMic(); cap.engine.stopCall();
  $('micBtn').textContent = 'Start microphone'; $('micState').textContent = 'off'; callStopped();
  status('capStatus', 'Finishing the last lines…');
  const t0 = Date.now();
  while ((cap.engine.queue.length || cap.engine.busy) && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 300));
  const ep = cap.ep; cap.ep = null; clearTimeout(cap.saveTimer);
  if (ep && ep.lines.length) {
    await store.saveEpisode(ep); await reloadEpisodes(); chatContext = null;
    status('capStatus', `Saved "${ep.title}" with ${ep.lines.length} lines.`, 'ok');
    syncSoon(); queueNotes();
  } else status('capStatus', 'Nothing was transcribed, so nothing was saved.');
  $('live').innerHTML = '<p class="muted small">Lines appear a few seconds after someone stops talking.</p>'; $('liveTitle').textContent = 'Live transcript';
  updateFinish();
});
addEventListener('beforeunload', (e) => { if (cap.ep) { store.saveEpisode(cap.ep); if (cap.engine.capturing) { e.preventDefault(); e.returnValue = ''; } } });

// ---------------- Settings ----------------
function fillSettings() {
  $('ownerName').value = settings.ownerName || '';
  $('ghOwner').value = settings.gh.owner; $('ghRepo').value = settings.gh.repo; $('ghToken').value = settings.gh.token;
  $('passphrase').value = settings.passphrase; $('apiKey').value = settings.apiKey; $('autoNotes').checked = settings.autoNotes !== false; $('aiModel').value = settings.aiModel || 'haiku';
}
$('ownerName').addEventListener('change', async () => { settings.ownerName = $('ownerName').value.trim(); await saveSettings(); chatContext = null; });
$('saveSync').addEventListener('click', async () => {
  settings.gh = { owner: $('ghOwner').value.trim(), repo: $('ghRepo').value.trim(), token: $('ghToken').value.trim() };
  settings.passphrase = $('passphrase').value;
  if (!syncConfigured()) { status('syncStatus', 'Fill in all four fields.', 'err'); return; }
  if (settings.passphrase.length < 10) { status('syncStatus', 'Use a passphrase of at least 10 characters.', 'err'); return; }
  await saveSettings(); sync = null;
  status('syncStatus', 'Connecting…'); runSync('setup');
});
$('forgetSync').addEventListener('click', async () => { settings.gh = { owner: '', repo: '', token: '' }; settings.passphrase = ''; sync = null; await saveSettings(); fillSettings(); setPill('', 'sync off'); status('syncStatus', 'Sync removed from this device. Local conversations are kept.'); });
$('saveKey').addEventListener('click', async () => {
  settings.apiKey = $('apiKey').value.trim(); settings.autoNotes = $('autoNotes').checked;
  if (settings.aiModel !== $('aiModel').value) { settings.aiModel = $('aiModel').value; chatContext = null; }
  await saveSettings(); status('keyStatus', settings.apiKey ? 'Saved on this device.' : 'Key removed.', 'ok');
  episodes.forEach((e) => delete e.notesError); queueNotes();
});
$('exportBtn').addEventListener('click', async () => {
  const pass = $('passphrase').value || settings.passphrase;
  if (!pass) { status('backupStatus', 'Enter a passphrase above first.', 'err'); return; }
  const blob = new Blob([await store.exportBundle(pass)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `dayline-backup-${new Date().toISOString().slice(0, 10)}.dayline`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  status('backupStatus', 'Backup downloaded. It can only be opened with your passphrase.', 'ok');
});
$('importBackup').addEventListener('change', async (ev) => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  const pass = $('passphrase').value || settings.passphrase;
  if (!pass) { status('backupStatus', 'Enter the passphrase above first.', 'err'); return; }
  try { const n = await store.importBundle(await f.text(), pass); await reloadEpisodes(); chatContext = null; status('backupStatus', `Imported ${n} conversation${n === 1 ? '' : 's'}.`, 'ok'); syncSoon(); queueNotes(); }
  catch (e) { status('backupStatus', e.message, 'err'); }
});
let clearArmed = false;
$('clearBtn').addEventListener('click', async () => {
  if (!clearArmed) { clearArmed = true; $('clearBtn').textContent = 'Tap again to erase this device'; status('clearStatus', 'Conversations already synced stay in your GitHub repo.'); return; }
  await store.clearLocal(); location.reload();
});

// ---------------- Start ----------------
(async function start() {
  try { const s = await store.kvGet('settings'); if (s) settings = { ...settings, ...s, gh: { ...settings.gh, ...(s.gh || {}) } }; } catch {}
  fillSettings();
  await reloadEpisodes();
  route();
  setPill('', syncConfigured() ? 'ready' : 'sync off');
  if (syncConfigured()) runSync('start'); else queueNotes();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
