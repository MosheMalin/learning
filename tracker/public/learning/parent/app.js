/* ===== מעקב הורים - the parent dashboard =====
   Plain JS, hash-routed. Everything shown comes from the tracker's parent
   API; nothing here reads an app's own storage. */

const API = '/learning/parent/api/';
const AUTH = '/learning/track/v1/auth/';
/* must match GOOGLE_CLIENT_ID in tracker/wrangler.toml */
const GOOGLE_CLIENT_ID = '731852048497-pved0t60dqc1pskdkj6tko4ct0qs8dtn.apps.googleusercontent.com';

const APP_NAMES = { 'english-words': 'אנגלית · המילים שלי' };
const appName = app => APP_NAMES[app] || app;

let me = null;
let students = [];

const $ = id => document.getElementById(id);
const screens = ['login', 'home', 'student', 'units', 'unit', 'session'];
function show(name) {
  screens.forEach(s => { $('screen-' + s).hidden = s !== name; });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const r = await fetch(API + path, { credentials: 'same-origin', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { me = null; renderAuth(); show('login'); throw new Error('not logged in'); }
  if (r.status === 403) { $('login-note').textContent = 'החשבון הזה אינו רשום כהורה.'; show('login'); throw new Error('forbidden'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

/* ---------- dates ---------- */
const fmtDay = new Intl.DateTimeFormat('he-IL', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayLong = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtTime = new Intl.DateTimeFormat('he-IL', { hour: '2-digit', minute: '2-digit' });
const fmtHeb = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long' });
const when = iso => iso ? `${fmtDay.format(new Date(iso))} · ${fmtTime.format(new Date(iso))}` : '';
const whenLong = iso => iso ? `${fmtDayLong.format(new Date(iso))} (${fmtHeb.format(new Date(iso))}) · ${fmtTime.format(new Date(iso))}` : '';
const localDay = iso => `${fmtDay.format(new Date(iso + 'T12:00:00'))} (${fmtHeb.format(new Date(iso + 'T12:00:00'))})`;
function ago(iso) {
  if (!iso) return 'עדיין לא';
  const d = (Date.now() - Date.parse(iso)) / 60000;
  if (d < 60) return `לפני ${Math.max(1, Math.round(d))} דק׳`;
  if (d < 60 * 36) return `לפני ${Math.round(d / 60)} שעות`;
  return `לפני ${Math.round(d / 1440)} ימים`;
}
function minutes(ms) {
  if (!ms) return '—';
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)} שנ׳` : `${m} דק׳`;
}
function daysUntil(iso) {
  if (!iso) return null;
  return Math.round((Date.parse(iso + 'T00:00:00') - new Date().setHours(0, 0, 0, 0)) / 86400000);
}
const isoToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ---------- scores ---------- */
function scoreCell(s) {
  if (s.score == null || !s.max_score) {
    const seen = s.answered_count || 0;
    return seen ? `<span class="score">${s.correct_first_try}/${seen}</span> <span class="status">בתהליך</span>` : '<span class="muted">—</span>';
  }
  const pct = s.score / s.max_score;
  const cls = pct >= 0.8 ? 'good' : pct >= 0.5 ? 'mid' : 'low';
  const extra = s.correct_eventually > s.correct_first_try ? ` <span class="status" title="נכון אחרי ניסיון נוסף">(+${s.correct_eventually - s.correct_first_try})</span>` : '';
  return `<span class="score ${cls}">${s.score}/${s.max_score}</span>${extra}`;
}
const statusLabel = { completed: '', in_progress: 'בתהליך', abandoned: 'לא הושלם' };
const resultLabel = { correct: 'נכון', almost: 'כמעט', wrong: 'לא נכון', unjudged: 'לא נבדק', skipped: 'דילגה' };

/* ---------- auth ---------- */
function renderAuth() {
  const el = $('auth');
  if (!me) { el.innerHTML = ''; return; }
  el.innerHTML = `${me.picture ? `<img src="${escapeHtml(me.picture)}" alt="">` : ''}
    <span>${escapeHtml(me.name)}</span> <button id="btn-logout" class="small-btn">יציאה</button>`;
  $('btn-logout').addEventListener('click', async () => {
    await fetch(AUTH + 'logout', { method: 'POST' }).catch(() => {});
    me = null; renderAuth(); show('login'); location.hash = '';
  });
}

function loadGis() {
  if (!GOOGLE_CLIENT_ID) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
    google.accounts.id.renderButton($('gsi-btn'), { theme: 'filled_blue', size: 'large', shape: 'pill', locale: 'he' });
  };
  s.onerror = () => { $('login-note').textContent = 'כפתור ההתחברות של Google לא נטען.'; };
  document.head.appendChild(s);
}

async function onGoogleCredential(resp) {
  try {
    const r = await fetch(AUTH + 'login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: resp.credential }),
    });
    if (!r.ok) { $('login-note').textContent = 'ההתחברות נכשלה, נסו שוב.'; return; }
    me = await r.json();
    renderAuth();
    route();
  } catch { $('login-note').textContent = 'ההתחברות נכשלה, נסו שוב.'; }
}

/* ---------- home ---------- */
async function renderHome() {
  const data = await api('students');
  students = data.students;
  // parents are family, not students: a parent card only appears once that
  // account has actually practised something
  const visible = students.filter(s => !s.hidden && (s.role !== 'parent' || s.last_session_at));
  const el = $('students');
  el.innerHTML = visible.map(s => `
    <div class="card student-card" data-sub="${escapeHtml(s.sub)}">
      <div class="who">
        ${s.picture ? `<img src="${escapeHtml(s.picture)}" alt="">` : '<span style="font-size:2em">🧒</span>'}
        <div>
          <div class="name">${escapeHtml(s.display_name || s.name || s.email)}</div>
          <div class="muted small">${s.role === 'parent' ? '<span class="tag parent">הורה</span>' : (s.grade ? `כיתה ${escapeHtml(s.grade)}` : '')}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${s.sessions_7d}</b><span>תרגולים השבוע</span></div>
        <div class="stat"><b>${minutes(s.duration_7d_ms)}</b><span>זמן השבוע</span></div>
        <div class="stat"><b>${ago(s.last_session_at)}</b><span>תרגול אחרון</span></div>
      </div>
    </div>`).join('') || '<p class="muted">עוד אין ילדים - אחרי התרגול הראשון הם יופיעו כאן.</p>';
  el.querySelectorAll('.student-card').forEach(c => c.addEventListener('click', () => { location.hash = '#/s/' + c.dataset.sub; }));
  show('home');
  crumbs([]);
}

/* ---------- one student ---------- */
let currentSub = null;

function studentName(sub) {
  const s = students.find(x => x.sub === sub);
  return s ? (s.display_name || s.name || s.email) : '';
}

async function ensureStudents() {
  if (!students.length) students = (await api('students')).students;
}

async function renderStudent(sub) {
  await ensureStudents();
  currentSub = sub;
  $('student-name').textContent = studentName(sub);
  if (!$('filter-from').value) {
    const from = new Date(Date.now() - 60 * 86400000);
    $('filter-from').value = new Date(from - from.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  show('student');
  crumbs([[studentName(sub), null]]);
  await Promise.all([renderHeatmap(sub), renderSessions(sub)]);
}

async function renderHeatmap(sub) {
  const { days, since } = await api(`students/${encodeURIComponent(sub)}/activity?days=120`);
  const byDay = new Map(days.map(d => [d.local_date, d]));
  const el = $('heatmap');
  el.innerHTML = '';
  const today = isoToday();
  // start on the Sunday on or before `since`, so columns are weeks
  const start = new Date(since + 'T12:00:00');
  start.setDate(start.getDate() - start.getDay());
  for (let d = new Date(start); ; d.setDate(d.getDate() + 1)) {
    const iso = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const cell = document.createElement('div');
    const row = byDay.get(iso);
    const n = row ? row.sessions : 0;
    cell.className = 'day ' + (iso > today ? 'future' : n === 0 ? '' : n === 1 ? 'l1' : n === 2 ? 'l2' : n <= 4 ? 'l3' : 'l4');
    cell.title = row ? `${localDay(iso)}: ${n} תרגולים, ${minutes(row.duration_ms)}` : localDay(iso);
    el.appendChild(cell);
    if (iso >= today && d.getDay() === 6) break;
  }
}

async function renderSessions(sub) {
  const from = $('filter-from').value, to = $('filter-to').value, app = $('filter-app').value;
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (app) q.set('app', app);
  const { sessions } = await api(`students/${encodeURIComponent(sub)}/sessions?` + q);
  // the app filter's options come from what this child has actually used
  const apps = [...new Set(sessions.map(s => s.app))];
  const sel = $('filter-app');
  const keep = sel.value;
  sel.innerHTML = '<option value="">הכל</option>' + apps.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(appName(a))}</option>`).join('');
  sel.value = keep;
  const tbody = $('sessions-table').querySelector('tbody');
  tbody.innerHTML = sessions.map(s => `
    <tr class="link" data-id="${escapeHtml(s.id)}">
      <td>${when(s.started_at)}</td>
      <td>${escapeHtml(s.unit_title || s.unit_id)}<div class="status">${escapeHtml(appName(s.app))}</div></td>
      <td>${escapeHtml(s.exercise_title || s.exercise_id)}${s.params && s.params.mistakesOnly ? ' <span class="tag">חזרה על טעויות</span>' : ''}</td>
      <td>${scoreCell(s)} ${statusLabel[s.status] ? `<div class="status">${statusLabel[s.status]}</div>` : ''}</td>
      <td>${minutes(s.duration_ms)}</td>
      <td><a href="#/u/${encodeURIComponent(sub)}/${encodeURIComponent(s.app)}/${encodeURIComponent(s.unit_id)}" class="small" onclick="event.stopPropagation()">שליטה ›</a></td>
    </tr>`).join('');
  $('sessions-empty').hidden = sessions.length > 0;
  tbody.querySelectorAll('tr.link').forEach(tr => tr.addEventListener('click', () => { location.hash = '#/r/' + tr.dataset.id; }));
}

['filter-from', 'filter-to', 'filter-app'].forEach(id => $(id).addEventListener('change', () => currentSub && renderSessions(currentSub)));
$('btn-units').addEventListener('click', () => { location.hash = '#/units/' + currentSub; });

/* ---------- edit a student ---------- */
$('btn-edit-student').addEventListener('click', () => {
  const s = students.find(x => x.sub === currentSub);
  if (!s) return;
  $('edit-name').value = s.display_name || s.name || '';
  $('edit-grade').value = s.grade || '';
  $('edit-hidden').checked = !!s.hidden;
  $('edit-parent').checked = s.role === 'parent';
  $('edit-overlay').hidden = false;
});
$('edit-cancel').addEventListener('click', () => { $('edit-overlay').hidden = true; });
$('edit-save').addEventListener('click', async () => {
  await api(`students/${encodeURIComponent(currentSub)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      display_name: $('edit-name').value.trim(),
      grade: $('edit-grade').value.trim(),
      hidden: $('edit-hidden').checked,
      role: $('edit-parent').checked ? 'parent' : 'student',
    }),
  });
  $('edit-overlay').hidden = true;
  students = [];
  await renderStudent(currentSub);
});

/* ---------- units ---------- */
async function renderUnits(sub) {
  await ensureStudents();
  $('units-title').textContent = `הרשימות והמבחנים של ${studentName(sub)}`;
  const { units } = await api(`students/${encodeURIComponent(sub)}/units`);
  $('units').innerHTML = units.map(u => {
    const exam = u.definition && u.definition.examDate;
    const d = daysUntil(exam);
    const examLine = exam ? (d > 0 ? `📅 מבחן בעוד ${d} ימים (${localDay(exam)})` : d === 0 ? '📅 המבחן היום!' : `📅 מבחן היה ב־${localDay(exam)}`) : '';
    return `<a class="card student-card" href="#/u/${encodeURIComponent(sub)}/${encodeURIComponent(u.app)}/${encodeURIComponent(u.unit_id)}">
      <div class="name"><b>${escapeHtml(u.title || u.unit_id)}</b></div>
      <div class="muted small">${escapeHtml(appName(u.app))} · ${u.sessions} תרגולים · אחרון ${ago(u.last_at)}</div>
      ${examLine ? `<div class="exam">${examLine}</div>` : ''}
    </a>`;
  }).join('') || '<p class="muted">עוד אין רשימות.</p>';
  show('units');
  crumbs([[studentName(sub), '#/s/' + sub], ['רשימות', null]]);
}

/* ---------- one unit: mastery ---------- */
async function renderUnit(sub, app, unitId) {
  await ensureStudents();
  const { unit, items } = await api(`students/${encodeURIComponent(sub)}/units/${encodeURIComponent(app)}/${encodeURIComponent(unitId)}`);
  $('unit-title').textContent = unit ? unit.title : unitId;
  const exam = unit && unit.definition && unit.definition.examDate;
  const d = daysUntil(exam);
  $('unit-sub').textContent = [appName(app), exam ? (d > 0 ? `המבחן בעוד ${d} ימים (${localDay(exam)})` : d === 0 ? 'המבחן היום' : `המבחן היה ב־${localDay(exam)}`) : ''].filter(Boolean).join(' · ');
  // weakest first: never seen, then lowest first-try rate, then least seen
  const rate = it => it.seen ? it.first_try_correct / it.seen : -1;
  items.sort((a, b) => rate(a) - rate(b) || a.seen - b.seen);
  const tbody = $('mastery-table').querySelector('tbody');
  tbody.innerHTML = items.map(it => {
    const def = it.definition || {};
    const label = def.en ? `<span class="en">${escapeHtml(def.en)}</span> · ${escapeHtml(def.he || '')}` : escapeHtml(it.title || it.item_id);
    const weak = it.seen && rate(it) < 0.5;
    const dots = it.recent.map(r => `<span class="dot ${r.result === 'correct' && !r.first_try ? 'retry' : r.result}" title="${escapeHtml(resultLabel[r.result] || r.result)}${r.first_try ? '' : ' (לא בניסיון הראשון)'} · ${escapeHtml(r.exercise)} · ${when(r.at)}"></span>`).join('');
    return `<tr class="${weak ? 'weak' : ''}">
      <td>${label}</td>
      <td>${it.seen || '<span class="muted">עוד לא</span>'}</td>
      <td>${it.seen ? `${it.first_try_correct}/${it.seen} (${Math.round(rate(it) * 100)}%)` : '—'}</td>
      <td><span class="dots">${dots}</span></td>
      <td>${it.last_at ? when(it.last_at) : '—'}</td>
    </tr>`;
  }).join('');
  show('unit');
  crumbs([[studentName(sub), '#/s/' + sub], ['רשימות', '#/units/' + sub], [unit ? unit.title : unitId, null]]);
}

/* ---------- one session ---------- */
let currentSessionId = null;

function promptText(p, def) {
  if (!p) return def && def.en ? `<span class="en">${escapeHtml(def.en)}</span>` : '';
  if (p.audio) return `🎧 <span class="en">${escapeHtml(p.audio)}</span>`;
  const he = p.he ? ` <span class="muted">(${escapeHtml(p.he)})</span>` : '';
  return /[֐-׿]/.test(p.text || '') ? escapeHtml(p.text) + he : `<span class="en">${escapeHtml(p.text || '')}</span>${he}`;
}

async function renderSession(id) {
  await ensureStudents();
  currentSessionId = id;
  const { session: s, attempts } = await api(`sessions/${encodeURIComponent(id)}`);
  $('session-title').textContent = `${s.unit_title || s.unit_id} · ${s.exercise_title || s.exercise_id}`;
  const parts = [studentName(s.student), whenLong(s.started_at), appName(s.app), minutes(s.duration_ms)];
  if (statusLabel[s.status]) parts.push(statusLabel[s.status]);
  if (s.params && s.params.mistakesOnly) parts.push('חזרה על הטעויות מהתרגול הקודם');
  $('session-sub').innerHTML = parts.map(escapeHtml).join(' · ') + ' · ' + scoreCell(s);
  const tbody = $('attempts-table').querySelector('tbody');
  tbody.innerHTML = attempts.map(a => {
    const def = a.item_definition || {};
    const answer = def.en ? `<div class="status">התשובה: <span class="en">${escapeHtml(def.en)}</span>${def.he ? ` · ${escapeHtml(def.he)}` : ''}</div>` : '';
    const tries = (a.tries_json || []).map(t => `
      <div class="try">
        <span class="pill ${t.result}">${escapeHtml(resultLabel[t.result] || t.result)}</span>
        <span class="resp en">${escapeHtml(t.response || '')}</span>
        ${t.judgedBy === 'llm' ? '<span class="status" title="נבדק על ידי Claude">🤖</span>' : ''}
        ${t.feedback ? `<div class="note">${escapeHtml(t.feedback)}</div>` : ''}
      </div>`).join('') || '<span class="muted">לא ענתה</span>';
    const final = a.final_result || (a.tries ? '' : 'skipped');
    const verdict = a.first_try_correct ? '<span class="pill correct">נכון מיד</span>'
      : a.success ? '<span class="pill almost">נכון בניסיון נוסף</span>'
      : a.tries ? `<span class="pill ${final}">${escapeHtml(resultLabel[final] || final)}</span>` : '<span class="pill skipped">לא ענתה</span>';
    return `<tr>
      <td>${a.seq}</td>
      <td>${promptText(a.prompt, def)}${answer}</td>
      <td><div class="tries">${tries}</div></td>
      <td>${verdict}</td>
      <td>${a.latency_ms != null ? `${Math.round(a.latency_ms / 1000)} שנ׳` : '—'}</td>
    </tr>`;
  }).join('');
  show('session');
  crumbs([[studentName(s.student), '#/s/' + s.student], ['תרגול', null]]);
}

$('btn-delete-session').addEventListener('click', async () => {
  if (!confirm('להסתיר את התרגול הזה מהדוחות? האירועים עצמם נשמרים.')) return;
  await api(`sessions/${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' });
  history.back();
});

/* ---------- routing ---------- */
function crumbs(items) {
  $('crumbs').innerHTML = items.map(([label, href]) => href ? `<a href="${href}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`).join('');
}

async function route() {
  if (!me) { show('login'); return; }
  const h = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = h.split('/').map(decodeURIComponent);
  try {
    if (kind === 's' && rest[0]) return await renderStudent(rest[0]);
    if (kind === 'units' && rest[0]) return await renderUnits(rest[0]);
    if (kind === 'u' && rest.length >= 3) return await renderUnit(rest[0], rest[1], rest.slice(2).join('/'));
    if (kind === 'r' && rest[0]) return await renderSession(rest[0]);
    return await renderHome();
  } catch (e) {
    if (e.message !== 'not logged in' && e.message !== 'forbidden') {
      $('main').insertAdjacentHTML('afterbegin', `<p class="card" style="color:var(--bad)">${escapeHtml(e.message)}</p>`);
    }
  }
}
window.addEventListener('hashchange', route);

async function init() {
  loadGis();
  try {
    const r = await fetch(AUTH + 'me', { credentials: 'same-origin' });
    if (r.ok) {
      me = await r.json();
      if (me.role !== 'parent') { $('login-note').textContent = `החשבון ${me.email} אינו רשום כהורה.`; me = null; }
    }
  } catch {}
  renderAuth();
  route();
}
init();
