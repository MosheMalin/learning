/* ===== מעקב הורים - the parent dashboard =====
   Plain JS, hash-routed. Everything shown comes from the tracker's parent
   API; nothing here reads an app's own storage. */

const API = '/learning/parent/api/';
const AUTH = '/learning/track/v1/auth/';

const APP_NAMES = { 'english-words': 'אנגלית · המילים שלי' };
const appName = app => APP_NAMES[app] || app;

let me = null;
let students = [];
let showHidden = false;

const $ = id => document.getElementById(id);
const screens = ['login', 'home', 'student', 'units', 'unit', 'session'];
function show(name) {
  screens.forEach(s => { $('screen-' + s).hidden = s !== name; });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const loading = '<p class="muted loading">טוען…</p>';

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
const fmtMonth = new Intl.DateTimeFormat('he-IL', { month: 'short' });
const when = iso => iso ? `${fmtDay.format(new Date(iso))} · ${fmtTime.format(new Date(iso))}` : '';
const hebOf = iso => iso ? fmtHeb.format(new Date(iso)) : '';
const whenLong = iso => iso ? `${fmtDayLong.format(new Date(iso))} · ${hebOf(iso)} · ${fmtTime.format(new Date(iso))}` : '';
const noon = day => new Date(day + 'T12:00:00');
const localDay = day => `${fmtDay.format(noon(day))} · ${fmtHeb.format(noon(day))}`;
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
function daysUntil(day) {
  if (!day) return null;
  return Math.round((Date.parse(day + 'T00:00:00') - new Date().setHours(0, 0, 0, 0)) / 86400000);
}
function examLine(day) {
  const d = daysUntil(day);
  if (d === null) return '';
  if (d > 0) return `📅 מבחן בעוד ${d} ימים (${localDay(day)})`;
  if (d === 0) return '📅 המבחן היום!';
  return `📅 המבחן היה ב־${localDay(day)}`;
}
const isoToday = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ---------- scores ---------- */
const statusLabel = { completed: '', in_progress: 'בתהליך', abandoned: 'הפסיקה באמצע' };
/* where the round's words came from, when not the whole list */
function sourceTag(params) {
  if (!params) return '';
  if (params.source === 'weak') return ' <span class="tag">חיזוק מילים קשות</span>';
  if (params.mistakesOnly) return ' <span class="tag">חזרה על טעויות</span>';
  return '';
}
const resultLabel = { correct: 'נכון', almost: 'כמעט', wrong: 'לא נכון', unjudged: 'לא נבדק', skipped: 'דילגה' };

/* A finished round shows its score; an unfinished one says how far she got,
   never an n/n that reads as full marks. */
function scoreCell(s) {
  if (s.status !== 'completed' || s.score == null || !s.max_score) {
    const seen = s.answered_count || 0;
    const of = s.item_count ? ` מתוך ${s.item_count}` : '';
    return `<span class="muted">ענתה על ${seen}${of}</span>` +
      (seen ? ` <span class="status">${s.correct_first_try} נכון</span>` : '') +
      (statusLabel[s.status] ? `<div class="status">${statusLabel[s.status]}</div>` : '');
  }
  const pct = s.score / s.max_score;
  const cls = pct >= 0.8 ? 'good' : pct >= 0.5 ? 'mid' : 'low';
  const later = s.correct_eventually - s.correct_first_try;
  const extra = later > 0 ? ` <span class="status" title="נכון אחרי ניסיון נוסף">ועוד ${later} בניסיון נוסף</span>` : '';
  return `<span class="score ${cls}">${s.score}/${s.max_score}</span>${extra}`;
}

/* ---------- auth ---------- */
function renderAuth() {
  const el = $('auth');
  if (!me) { el.innerHTML = ''; return; }
  el.innerHTML = `${me.picture ? `<img src="${escapeHtml(me.picture)}" alt="">` : ''}
    <span>${escapeHtml(me.name)}</span> <button id="btn-logout" class="small-btn">יציאה</button>`;
  $('btn-logout').addEventListener('click', logout);
}

async function logout() {
  await fetch(AUTH + 'logout', { method: 'POST' }).catch(() => {});
  me = null; renderAuth(); $('login-note').textContent = ''; $('gate-logout').hidden = true;
  show('login'); location.hash = '';
}
$('gate-logout').addEventListener('click', logout);

/* the Google client id lives in the tracker's config, not in this file */
async function loadGis() {
  let clientId = '';
  try { clientId = (await (await fetch(AUTH + 'config')).json()).clientId; } catch {}
  if (!clientId) { $('login-note').textContent = 'ההתחברות עם Google אינה מוגדרת בשרת הזה.'; return; }
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: clientId, callback: onGoogleCredential });
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
    const user = await r.json();
    if (user.role !== 'parent') { notAParent(user); return; }
    me = user;
    renderAuth();
    route();
  } catch { $('login-note').textContent = 'ההתחברות נכשלה, נסו שוב.'; }
}

function notAParent(user) {
  $('login-note').textContent = `החשבון ${user.email} אינו רשום כהורה.`;
  $('gate-logout').hidden = false;
}

/* ---------- home ---------- */
function studentCard(s) {
  const exam = s.next_exam;
  const examHtml = exam ? `<div class="exam">
      <a href="#/u/${encodeURIComponent(s.sub)}/${encodeURIComponent(exam.app)}/${encodeURIComponent(exam.unit_id)}">${escapeHtml(exam.title || exam.unit_id)}</a>:
      ${examLine(exam.exam_date)}<br>
      <span class="muted">${exam.known} מתוך ${exam.items} מילים יושבות, ${exam.weak} חלשות${exam.unseen ? `, ${exam.unseen} עוד לא תורגלו` : ''}</span>
    </div>` : '';
  return `
    <div class="card student-card${s.hidden ? ' is-hidden' : ''}" data-sub="${escapeHtml(s.sub)}">
      <div class="who">
        ${s.picture ? `<img src="${escapeHtml(s.picture)}" alt="">` : '<span style="font-size:2em">🧒</span>'}
        <div>
          <div class="name">${escapeHtml(s.display_name || s.name || s.email)}</div>
          <div class="muted small">${s.role === 'parent' ? '<span class="tag parent">הורה</span> ' : ''}${s.grade ? `כיתה ${escapeHtml(s.grade)}` : ''}${s.hidden ? ' <span class="tag">מוסתר</span>' : ''}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><b>${s.sessions_7d}</b><span>תרגולים השבוע</span></div>
        <div class="stat"><b>${minutes(s.duration_7d_ms)}</b><span>זמן השבוע</span></div>
        <div class="stat"><b>${s.streak}</b><span>ימים ברצף</span></div>
        <div class="stat"><b>${ago(s.last_session_at)}</b><span>תרגול אחרון</span></div>
      </div>
      ${examHtml}
    </div>`;
}

async function renderHome(token) {
  show('home');
  crumbs([]);
  $('students').innerHTML = loading;
  const data = await api('students');
  if (token !== routeToken) return;
  students = data.students;
  // parents are family, not students: a parent card only appears once that
  // account has actually practised something
  const family = students.filter(s => s.role !== 'parent' || s.last_session_at);
  const visible = family.filter(s => showHidden || !s.hidden);
  const hiddenCount = family.length - family.filter(s => !s.hidden).length;
  const el = $('students');
  el.innerHTML = visible.map(studentCard).join('') || '<p class="muted">עוד אין ילדים - אחרי התרגול הראשון הם יופיעו כאן.</p>';
  el.querySelectorAll('.student-card').forEach(c => c.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    location.hash = '#/s/' + c.dataset.sub;
  }));
  const toggle = $('toggle-hidden');
  toggle.hidden = hiddenCount === 0;
  toggle.textContent = showHidden ? 'להסתיר שוב את המוסתרים' : `הצגת ${hiddenCount} מוסתרים`;
}
$('toggle-hidden').addEventListener('click', () => { showHidden = !showHidden; route(); });

/* ---------- one student ---------- */
let currentSub = null;

function studentName(sub) {
  const s = students.find(x => x.sub === sub);
  return s ? (s.display_name || s.name || s.email) : '';
}

async function ensureStudents() {
  if (!students.length) students = (await api('students')).students;
}

async function renderStudent(sub, token) {
  currentSub = sub;
  $('sessions-table').querySelector('tbody').innerHTML = '';
  $('sessions-empty').hidden = false;
  $('sessions-empty').textContent = 'טוען…';
  $('heatmap').innerHTML = '';
  $('heatmap-months').innerHTML = '';
  show('student');
  await ensureStudents();
  if (token !== routeToken) return;
  $('student-name').textContent = studentName(sub);
  crumbs([[studentName(sub), null]]);
  if (!$('filter-from').value) {
    const from = new Date(Date.now() - 60 * 86400000);
    $('filter-from').value = new Date(from - from.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  await Promise.all([renderHeatmap(sub, token), renderSessions(sub, token)]);
}

async function renderHeatmap(sub, token) {
  const { days, since } = await api(`students/${encodeURIComponent(sub)}/activity?days=120`);
  if (token !== routeToken) return;
  const byDay = new Map(days.map(d => [d.local_date, d]));
  const el = $('heatmap');
  const monthsEl = $('heatmap-months');
  el.innerHTML = '';
  monthsEl.innerHTML = '';
  const today = isoToday();
  // start on the Sunday on or before `since`, so columns are weeks
  const start = noon(since);
  start.setDate(start.getDate() - start.getDay());
  let column = 0;
  for (let d = new Date(start); ; d.setDate(d.getDate() + 1)) {
    const iso = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    if (d.getDay() === 0) {
      // label the week that holds the first of a month
      const m = document.createElement('span');
      const weekEnd = new Date(d); weekEnd.setDate(weekEnd.getDate() + 6);
      m.textContent = d.getDate() <= 7 ? fmtMonth.format(d) : (weekEnd.getDate() <= 7 && weekEnd.getMonth() !== d.getMonth() ? fmtMonth.format(weekEnd) : '');
      monthsEl.appendChild(m);
      column++;
    }
    const cell = document.createElement('div');
    const row = byDay.get(iso);
    const n = row ? row.sessions : 0;
    cell.className = 'day ' + (iso > today ? 'future' : n === 0 ? '' : n === 1 ? 'l1' : n === 2 ? 'l2' : n <= 4 ? 'l3' : 'l4') + (iso === today ? ' today' : '');
    cell.title = row ? `${localDay(iso)}: ${n} תרגולים, ${minutes(row.duration_ms)}` : localDay(iso);
    el.appendChild(cell);
    if (iso >= today && d.getDay() === 6) break;
  }
}

async function renderSessions(sub, token) {
  const from = $('filter-from').value, to = $('filter-to').value, app = $('filter-app').value;
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (app) q.set('app', app);
  const { sessions } = await api(`students/${encodeURIComponent(sub)}/sessions?` + q);
  if (token !== routeToken) return;
  // the app filter's options come from what this child has actually used
  const apps = [...new Set(sessions.map(s => s.app))];
  const sel = $('filter-app');
  const keep = sel.value;
  sel.innerHTML = '<option value="">הכל</option>' + apps.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(appName(a))}</option>`).join('');
  sel.value = keep;
  const tbody = $('sessions-table').querySelector('tbody');
  tbody.innerHTML = sessions.map(s => `
    <tr class="link" data-id="${escapeHtml(s.id)}">
      <td>${when(s.started_at)}<div class="status">${hebOf(s.started_at)}</div></td>
      <td><a href="#/u/${encodeURIComponent(sub)}/${encodeURIComponent(s.app)}/${encodeURIComponent(s.unit_id)}">${escapeHtml(s.unit_title || s.unit_id)}</a><div class="status">${escapeHtml(appName(s.app))}</div></td>
      <td>${escapeHtml(s.exercise_title || s.exercise_id)}${sourceTag(s.params)}</td>
      <td>${scoreCell(s)}</td>
      <td>${minutes(s.duration_ms)}</td>
    </tr>`).join('');
  $('sessions-empty').textContent = 'עוד אין תרגולים בתקופה הזאת.';
  $('sessions-empty').hidden = sessions.length > 0;
  tbody.querySelectorAll('tr.link').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    location.hash = '#/r/' + tr.dataset.id;
  }));
}

['filter-from', 'filter-to', 'filter-app'].forEach(id => $(id).addEventListener('change', () => currentSub && renderSessions(currentSub, routeToken)));
$('btn-units').addEventListener('click', () => { location.hash = '#/units/' + currentSub; });

/* ---------- edit a student ---------- */
$('btn-edit-student').addEventListener('click', () => {
  const s = students.find(x => x.sub === currentSub);
  if (!s) return;
  $('edit-name').value = s.display_name || s.name || '';
  $('edit-grade').value = s.grade || '';
  $('edit-hidden').checked = !!s.hidden;
  $('edit-parent').checked = s.role === 'parent';
  $('edit-parent').disabled = s.sub === me.sub;    // a parent cannot demote themself
  $('edit-overlay').hidden = false;
});
$('edit-cancel').addEventListener('click', () => { $('edit-overlay').hidden = true; });
$('edit-save').addEventListener('click', async () => {
  const btn = $('edit-save');
  btn.disabled = true; btn.textContent = 'שומרים…';
  try {
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
    await route();
  } catch (e) {
    alert('השמירה נכשלה: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'שמירה';
  }
});

/* ---------- units ---------- */
async function renderUnits(sub, token) {
  show('units');
  $('units').innerHTML = loading;
  await ensureStudents();
  const { units } = await api(`students/${encodeURIComponent(sub)}/units`);
  if (token !== routeToken) return;
  $('units-title').textContent = `הרשימות והמבחנים של ${studentName(sub)}`;
  $('units').innerHTML = units.map(u => {
    const exam = u.definition && u.definition.examDate;
    return `<a class="card student-card" href="#/u/${encodeURIComponent(sub)}/${encodeURIComponent(u.app)}/${encodeURIComponent(u.unit_id)}">
      <div class="name"><b>${escapeHtml(u.title || u.unit_id)}</b></div>
      <div class="muted small">${escapeHtml(appName(u.app))} · ${u.sessions} תרגולים · אחרון ${ago(u.last_at)}</div>
      ${exam ? `<div class="exam">${examLine(exam)}</div>` : ''}
    </a>`;
  }).join('') || '<p class="muted">עוד אין רשימות.</p>';
  crumbs([[studentName(sub), '#/s/' + sub], ['רשימות', null]]);
}

/* ---------- one unit: mastery ---------- */
async function renderUnit(sub, app, unitId, token) {
  show('unit');
  $('mastery-table').querySelector('tbody').innerHTML = `<tr><td colspan="5">${loading}</td></tr>`;
  await ensureStudents();
  const { unit, items } = await api(`students/${encodeURIComponent(sub)}/units/${encodeURIComponent(app)}/${encodeURIComponent(unitId)}`);
  if (token !== routeToken) return;
  $('unit-title').textContent = unit ? unit.title : unitId;
  const exam = unit && unit.definition && unit.definition.examDate;
  $('unit-sub').textContent = [appName(app), exam ? examLine(exam) : ''].filter(Boolean).join(' · ');
  // the tracker's own "needs work" first (the same rule the app's offer uses),
  // then never seen, then by first-try rate
  const rate = it => it.seen ? it.first_try_correct / it.seen : -1;
  items.sort((a, b) => (b.weak ? 1 : 0) - (a.weak ? 1 : 0) || rate(a) - rate(b) || a.seen - b.seen);
  const tbody = $('mastery-table').querySelector('tbody');
  tbody.innerHTML = items.map(it => {
    const def = it.definition || {};
    const label = def.en ? `<span class="en">${escapeHtml(def.en)}</span> · ${escapeHtml(def.he || '')}` : escapeHtml(it.title || it.item_id);
    const weak = !!it.weak;
    const dots = it.recent.map(r => {
      const cls = r.result === 'correct' && !r.first_try ? 'retry' : r.result;
      const label2 = r.first_try ? 'נכון מיד' : (resultLabel[r.result] || r.result) + (r.result === 'correct' ? ' בניסיון נוסף' : '');
      return `<span class="dot ${cls}" title="${escapeHtml(label2)} · ${escapeHtml(r.exercise)} · ${when(r.at)}"></span>`;
    }).join('');
    return `<tr class="${weak ? 'weak' : ''}">
      <td>${label}</td>
      <td>${it.seen || '<span class="muted">עוד לא</span>'}</td>
      <td>${it.seen ? `${it.first_try_correct}/${it.seen} (${Math.round(rate(it) * 100)}%)` : '—'}</td>
      <td><span class="dots">${dots}</span></td>
      <td>${it.last_at ? when(it.last_at) : '—'}</td>
    </tr>`;
  }).join('');
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

async function renderSession(id, token) {
  show('session');
  currentSessionId = id;
  $('attempts-table').querySelector('tbody').innerHTML = `<tr><td colspan="5">${loading}</td></tr>`;
  $('session-title').textContent = '';
  $('session-sub').innerHTML = '';
  await ensureStudents();
  const { session: s, attempts } = await api(`sessions/${encodeURIComponent(id)}`);
  if (token !== routeToken) return;
  $('session-title').textContent = `${s.unit_title || s.unit_id} · ${s.exercise_title || s.exercise_id}`;
  const parts = [
    `<a href="#/s/${encodeURIComponent(s.student)}">${escapeHtml(studentName(s.student))}</a>`,
    escapeHtml(whenLong(s.started_at)), escapeHtml(appName(s.app)), escapeHtml(minutes(s.duration_ms)),
  ];
  if (s.params && s.params.source === 'weak') parts.push('חיזוק המילים שהתקשתה בהן');
  else if (s.params && s.params.mistakesOnly) {
    parts.push(s.params.retryOf
      ? `<a href="#/r/${encodeURIComponent(s.params.retryOf)}">חזרה על הטעויות מהתרגול הקודם</a>`
      : 'חזרה על הטעויות מהתרגול הקודם');
  }
  $('session-sub').innerHTML = parts.join(' · ') + ' · ' + scoreCell(s);
  const tbody = $('attempts-table').querySelector('tbody');
  const isWrite = s.exercise_id === 'write';
  tbody.innerHTML = attempts.map(a => {
    const def = a.item_definition || {};
    // the write prompt already names the word; elsewhere show the answer she was after
    const answer = def.en && !isWrite ? `<div class="status">התשובה: <span class="en">${escapeHtml(def.en)}</span>${def.he ? ` · ${escapeHtml(def.he)}` : ''}</div>` : '';
    const tries = (a.tries_json || []).map(t => `
      <div class="try">
        <span class="pill ${t.result}">${escapeHtml(resultLabel[t.result] || t.result)}</span>
        <span class="resp en">${escapeHtml(t.response || '')}</span>
        ${t.judgedBy === 'llm' && t.result !== 'unjudged' ? '<span class="status" title="נבדק על ידי Claude">🤖</span>' : ''}
        ${t.feedback ? `<div class="note">${escapeHtml(t.feedback)}</div>` : ''}
      </div>`).join('') || '<span class="muted">לא ענתה</span>';
    const final = a.final_result || (a.tries ? '' : 'skipped');
    const verdict = a.first_try_correct ? '<span class="pill correct">נכון מיד</span>'
      : a.success ? '<span class="pill almost">נכון בניסיון נוסף</span>'
      : a.tries ? `<span class="pill ${final}">${escapeHtml(resultLabel[final] || final)}</span>` : '<span class="pill skipped">לא ענתה</span>';
    return `<tr>
      <td data-label="#">${a.seq}</td>
      <td data-label="השאלה">${promptText(a.prompt, def)}${answer}</td>
      <td data-label="התשובות שלה"><div class="tries">${tries}</div></td>
      <td data-label="תוצאה">${verdict}</td>
      <td data-label="זמן לתשובה">${a.latency_ms != null ? `${Math.round(a.latency_ms / 1000)} שנ׳` : '—'}</td>
    </tr>`;
  }).join('');
  const missing = (s.item_count || 0) - attempts.length;
  if (missing > 0) {
    tbody.insertAdjacentHTML('beforeend', `<tr><td colspan="5" class="muted">${missing} שאלות לא הגיעו אליה - התרגול נעצר לפני כן</td></tr>`);
  }
  crumbs([[studentName(s.student), '#/s/' + s.student], ['תרגול', null]]);
}

$('btn-delete-session').addEventListener('click', async () => {
  if (!confirm('להסתיר את התרגול הזה מהדוחות? האירועים עצמם נשמרים.')) return;
  const btn = $('btn-delete-session');
  btn.disabled = true;
  try {
    await api(`sessions/${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' });
    location.hash = '#/s/' + (currentSub || '');
  } catch (e) {
    alert('לא הצלחנו להסתיר: ' + e.message);
  } finally { btn.disabled = false; }
});

/* ---------- routing ---------- */
let routeToken = 0;

function crumbs(items) {
  $('crumbs').innerHTML = items.map(([label, href]) => href ? `<a href="${href}">${escapeHtml(label)}</a>` : `<span>${escapeHtml(label)}</span>`).join('<span class="sep">·</span>');
}

/* Every navigation gets a token; a response that arrives for an older
   navigation is dropped, so the screen always matches the URL. */
async function route() {
  document.querySelectorAll('main > .error').forEach(e => e.remove());
  if (!me) { show('login'); return; }
  const token = ++routeToken;
  const h = location.hash.replace(/^#\/?/, '');
  const [kind, ...rest] = h.split('/').map(decodeURIComponent);
  try {
    if (kind === 's' && rest[0]) return await renderStudent(rest[0], token);
    if (kind === 'units' && rest[0]) return await renderUnits(rest[0], token);
    if (kind === 'u' && rest.length >= 3) return await renderUnit(rest[0], rest[1], rest.slice(2).join('/'), token);
    if (kind === 'r' && rest[0]) { currentSub = currentSub || null; return await renderSession(rest[0], token); }
    return await renderHome(token);
  } catch (e) {
    if (token === routeToken && e.message !== 'not logged in' && e.message !== 'forbidden') {
      $('main').insertAdjacentHTML('afterbegin', `<p class="card error">${escapeHtml(e.message)}</p>`);
    }
  }
}
window.addEventListener('hashchange', route);

async function init() {
  loadGis();
  try {
    const r = await fetch(AUTH + 'me', { credentials: 'same-origin' });
    if (r.ok) {
      const user = await r.json();
      if (user.role === 'parent') me = user; else notAParent(user);
    }
  } catch {}
  renderAuth();
  route();
}
init();
