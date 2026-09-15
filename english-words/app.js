/* ===== המילים שלי — English spelling practice ===== */

const STORAGE_KEY = 'english-words-lists';

/* Google OAuth Client ID - must match GOOGLE_CLIENT_ID in wrangler.toml.
   Empty = the sign-in button is hidden and the app runs in local-only mode. */
const GOOGLE_CLIENT_ID = '731852048497-pved0t60dqc1pskdkj6tko4ct0qs8dtn.apps.googleusercontent.com';

/* ---------- Storage ----------
   Guest mode: lists live in localStorage on this device.
   Signed in: lists live in the cloud (per Google account), localStorage untouched. */

let currentUser = null; // {sub, email, name, picture} when signed in

function loadLists() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

let cloudPushTimer = null;

function saveLists(l) {
  if (currentUser) {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(pushCloudLists, 800);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(l));
  }
}

function pushCloudLists() {
  return fetch('api/lists', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(lists),
  }).catch(() => {});
}

let lists = loadLists();
let currentListId = null;   // list being viewed / practiced
let editingListId = null;   // list being edited (null = new)

/* ---------- Screens ---------- */

const screens = {
  login: document.getElementById('screen-login'),
  home: document.getElementById('screen-home'),
  editor: document.getElementById('screen-editor'),
  list: document.getElementById('screen-list'),
  practice: document.getElementById('screen-practice'),
  summary: document.getElementById('screen-summary'),
};

function show(name) {
  Object.values(screens).forEach(s => s.hidden = true);
  screens[name].hidden = false;
  document.body.classList.toggle('typing-screen', name === 'editor' || name === 'practice');
  window.scrollTo(0, 0);
}

document.getElementById('app-title').addEventListener('click', () => {
  if (!currentUser) return; // login is mandatory
  renderHome();
  show('home');
});

document.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    stopSpeech();
    const target = btn.dataset.back;
    if (target === 'home') { renderHome(); show('home'); }
    else if (target === 'list') { renderListView(); show('list'); }
  });
});

/* ---------- Helpers ---------- */

function getList(id) {
  return lists.find(l => l.id === id);
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/* ---------- Hebrew calendar helpers ---------- */

const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const hebFmtEn = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' });
const hebFmtHeMonth = new Intl.DateTimeFormat('he-u-ca-hebrew', { month: 'long' });

/* Hebrew year in letters, e.g. 5786 -> תשפ״ו */
function hebYearName(date) {
  let n = hebParts(date).year % 1000;
  let s = '';
  for (const [v, l] of [[400, 'ת'], [300, 'ש'], [200, 'ר'], [100, 'ק']]) {
    while (n >= v) { s += l; n -= v; }
  }
  if (n === 15) { s += 'טו'; n = 0; }
  else if (n === 16) { s += 'טז'; n = 0; }
  else {
    const tens = { 90: 'צ', 80: 'פ', 70: 'ע', 60: 'ס', 50: 'נ', 40: 'מ', 30: 'ל', 20: 'כ', 10: 'י' };
    for (const v of [90, 80, 70, 60, 50, 40, 30, 20, 10]) {
      if (n >= v) { s += tens[v]; n -= v; break; }
    }
  }
  s += ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'][n];
  return s.length > 1 ? s.slice(0, -1) + '״' + s.slice(-1) : s + '׳';
}

function hebParts(date) {
  const parts = {};
  hebFmtEn.formatToParts(date).forEach(p => { if (p.type !== 'literal') parts[p.type] = p.value; });
  return { day: +parts.day, month: parts.month, year: +parts.year };
}

/* Hebrew numeral for a day of month (1-30) */
function gematria(n) {
  if (n === 15) return 'ט״ו';
  if (n === 16) return 'ט״ז';
  const ones = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  const tens = ['', 'י', 'כ', 'ל'];
  const t = tens[Math.floor(n / 10)], o = ones[n % 10];
  if (t && o) return t + '״' + o;
  return (t || o) + '׳';
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function isoOf(date) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0');
}

function dateOfIso(iso) {
  return new Date(iso + 'T00:00:00');
}

/* "י״ז באלול" for a Gregorian ISO date */
function hebDayMonth(iso) {
  if (!iso) return '';
  const d = dateOfIso(iso);
  return gematria(hebParts(d).day) + ' ב' + hebFmtHeMonth.format(d);
}

/* "יום רביעי, י״ז באלול תשפ״ו (10.09.2026)" */
function fmtFullDate(iso) {
  if (!iso) return '';
  const d = dateOfIso(iso);
  return `יום ${WEEKDAYS_HE[d.getDay()]}, ${hebDayMonth(iso)} ${hebYearName(d)} (${fmtDate(iso)})`;
}

/* Jewish holiday (or null) for a date, by its Hebrew-calendar parts */
function holidayFor(date, hp) {
  const m = hp.month, day = hp.day;
  if (m === 'Tishri') {
    if (day <= 2) return 'ראש השנה';
    if (day === 10) return 'יום כיפור';
    if (day >= 15 && day <= 21) return 'סוכות';
    if (day === 22) return 'שמחת תורה';
  }
  if (m === 'Kislev' && day >= 25) return 'חנוכה';
  if (m === 'Tevet' && day <= 3) {
    // Chanukah spills into Tevet: 2 days if Kislev has 30, 3 if it has 29
    const lastKislevDay = hebParts(addDays(date, -day)).day;
    if (day <= 8 - (lastKislevDay - 24)) return 'חנוכה';
  }
  if (m === 'Shevat' && day === 15) return 'ט״ו בשבט';
  if ((m === 'Adar' || m === 'Adar II') && day === 14) return 'פורים';
  if (m === 'Nisan') {
    if (day >= 15 && day <= 21) return 'פסח';
    if (day === 27) return 'יום השואה';
  }
  if (m === 'Iyar') {
    if (day >= 3 && day <= 6) {
      // Independence Day is 5 Iyar, shifted off Fri/Sat/Mon
      const fifth = addDays(date, 5 - day);
      const wd = fifth.getDay();
      let indep = 5;
      if (wd === 5) indep = 4;
      else if (wd === 6) indep = 3;
      else if (wd === 1) indep = 6;
      if (day === indep) return 'יום העצמאות';
      if (day === indep - 1) return 'יום הזיכרון';
    }
    if (day === 18) return 'ל״ג בעומר';
    if (day === 28) return 'יום ירושלים';
  }
  if (m === 'Sivan' && day === 6) return 'שבועות';
  if (m === 'Av' && day === 9) return 'תשעה באב';
  return null;
}

function daysUntil(iso) {
  if (!iso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exam = new Date(iso + 'T00:00:00');
  return Math.round((exam - today) / 86400000);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/* ---------- Speech (English TTS) ---------- */

const FEMALE_RE = /female|zira|aria|jenny|jessa|michelle|emma|libby|sonia|natasha|clara|samantha|ana\b|ava|susan|hazel|google us english$/i;
const MALE_RE = /\bmale|david|mark\b|guy|ryan|eric|andrew|brian|christopher|thomas|william|liam|george/i;

function englishVoices() {
  return speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
}

/* The chosen voice from the dropdown; before any choice, default to the
   best-sounding female-ish voice available (natural/neural voices first). */
function pickEnglishVoice() {
  const voices = englishVoices();
  if (!voices.length) return null;
  const stored = localStorage.getItem('voice-name');
  const match = voices.find(v => v.name === stored);
  if (match) return match;
  const rank = v =>
    (FEMALE_RE.test(v.name) ? 0 : !MALE_RE.test(v.name) ? 1 : 2) * 4 +
    (/natural|neural|online/i.test(v.name) ? 0 : 2) +
    (v.lang === 'en-US' ? 0 : 1);
  return [...voices].sort((a, b) => rank(a) - rank(b))[0];
}

/* ---- Primary voice: Google Translate TTS, streamed as audio.
   Same clear female voice in every browser, English and Hebrew.
   Browser speechSynthesis voices remain available as a fallback choice. ---- */

const GOOGLE_VOICE = '__google';

function voiceChoice() {
  return localStorage.getItem('voice-name') || GOOGLE_VOICE;
}

let ttsAudio = null;

/* served by our own origin: serve.py locally, a Pages Function on Cloudflare.
   Relative URL so it also works when the app is mounted under a path prefix. */
function googleTtsUrl(text, lang) {
  return 'tts?tl=' + lang + '&q=' + encodeURIComponent(text);
}

/* play clips [{text, lang, rate}] one after another; onFail switches to browser TTS */
function playGoogle(clips, onFail) {
  if (!ttsAudio) {
    ttsAudio = new Audio();
    ttsAudio.preservesPitch = true;
  }
  const audio = ttsAudio;
  let i = 0;
  const next = () => {
    if (i >= clips.length) return;
    const c = clips[i++];
    audio.src = googleTtsUrl(c.text, c.lang);
    audio.playbackRate = c.rate || 1;
    audio.onended = next;
    audio.onerror = () => { console.warn('Google TTS failed, falling back to browser voice'); if (onFail) onFail(); };
    audio.play().catch(() => { if (onFail) onFail(); });
  };
  next();
}

function stopSpeech() {
  speechSynthesis.cancel();
  if (ttsAudio) {
    ttsAudio.onended = null;
    ttsAudio.onerror = null;
    ttsAudio.pause();
  }
}

/* Edge quirks: an utterance queued right after cancel() can be dropped silently,
   the engine can get stuck paused, and garbage-collected utterances go silent. */
let keepUtterances = [];
function speakUtterances(utts) {
  keepUtterances = utts;
  speechSynthesis.cancel();
  speechSynthesis.resume();
  setTimeout(() => utts.forEach(u => speechSynthesis.speak(u)), 80);
}

function makeUtterance(text, lang, voice, rate) {
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = rate;
  if (voice) u.voice = voice;
  u.onerror = e => console.warn('TTS error for voice', voice && voice.name, e.error);
  return u;
}

function speakBrowser(text) {
  speakUtterances([makeUtterance(text, 'en-US', pickEnglishVoice(), 0.7)]);
}

function speak(text) {
  stopSpeech();
  if (voiceChoice() === GOOGLE_VOICE) {
    playGoogle([{ text, lang: 'en', rate: 0.8 }], () => speakBrowser(text));
  } else {
    speakBrowser(text);
  }
}

/* Voice sample: English hello, then a Hebrew greeting */
function speakSample() {
  stopSpeech();
  if (voiceChoice() === GOOGLE_VOICE) {
    playGoogle([
      { text: 'Hello! Welcome to my words!', lang: 'en', rate: 0.9 },
      { text: 'שלום! ככה אני אקריא את המילים', lang: 'iw', rate: 1 },
    ], speakSampleBrowser);
    return;
  }
  speakSampleBrowser();
}

function speakSampleBrowser() {
  const voice = pickEnglishVoice();
  const name = voice ? voiceLabel(voice).replace(/\(.*?\)|🇬🇧/g, '').trim() : 'the computer';
  const utts = [makeUtterance(`Hello! My name is ${name}. Welcome to my words!`, 'en-US', voice, 0.8)];
  const heVoices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('he'));
  if (heVoices.length) {
    utts.push(makeUtterance('שלום! ככה אני אקריא את המילים', 'he-IL', heVoices[0], 0.9));
  }
  speakUtterances(utts);
}

// some browsers load voices asynchronously
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.onvoiceschanged = () => populateVoiceSelects();
}

/* readable label: "Microsoft Aria Online (Natural) - English (United States)" -> "Aria (Natural)" */
function voiceLabel(v) {
  let name = v.name
    .replace(/^(Microsoft|Google|Apple)\s+/i, '')
    .replace(/\s*-?\s*English\s*\(.*\)$/i, '')
    .replace(/\s*Online\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const region = v.lang === 'en-US' ? '' : v.lang === 'en-GB' ? ' 🇬🇧' : ` (${v.lang})`;
  return name + region;
}

function populateVoiceSelects() {
  const voices = englishVoices();
  document.querySelectorAll('.voice-select').forEach(sel => {
    sel.innerHTML =
      `<option value="${GOOGLE_VOICE}">🌟 קול גוגל (מומלץ)</option>` +
      voices.map(v =>
        `<option value="${escapeHtml(v.name)}">${escapeHtml(voiceLabel(v))}</option>`).join('');
    sel.value = voiceChoice();
    if (!sel.value) sel.value = GOOGLE_VOICE;
  });
}

document.querySelectorAll('.voice-select').forEach(sel =>
  sel.addEventListener('change', () => {
    localStorage.setItem('voice-name', sel.value);
    populateVoiceSelects(); // keep both dropdowns in sync
    speakSample();
  }));
document.querySelectorAll('.voice-sample').forEach(b =>
  b.addEventListener('click', speakSample));

populateVoiceSelects();

/* ---------- In-app dialog (native alert/confirm are blocked in some browsers) ---------- */

const modalOverlay = document.getElementById('modal-overlay');
const modalOk = document.getElementById('modal-ok');
const modalCancel = document.getElementById('modal-cancel');
let modalOnOk = null;

function showAlert(msg) {
  document.getElementById('modal-msg').textContent = msg;
  modalOk.textContent = 'הבנתי';
  modalCancel.hidden = true;
  modalOnOk = null;
  modalOverlay.hidden = false;
}

function showConfirm(msg, okText, onOk) {
  document.getElementById('modal-msg').textContent = msg;
  modalOk.textContent = okText;
  modalCancel.hidden = false;
  modalOnOk = onOk;
  modalOverlay.hidden = false;
}

modalOk.addEventListener('click', () => {
  modalOverlay.hidden = true;
  const fn = modalOnOk;
  modalOnOk = null;
  if (fn) fn();
});
modalCancel.addEventListener('click', () => { modalOverlay.hidden = true; modalOnOk = null; });
modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) { modalOverlay.hidden = true; modalOnOk = null; }
});

/* ---------- Home ---------- */

function renderHome() {
  const container = document.getElementById('lists-container');
  if (lists.length === 0) {
    container.innerHTML = `<p class="empty-msg">עדיין אין רשימות...<br>לחצי על ➕ כדי להוסיף את הרשימה הראשונה! 🌟</p>`;
    return;
  }
  const sorted = [...lists].sort((a, b) => (b.examDate || '').localeCompare(a.examDate || ''));
  const emojis = ['🦄', '🌈', '⭐', '🌸', '🍭', '🎀', '🐬', '🧁', '💎', '🌺'];
  container.innerHTML = sorted.map((l, i) => {
    const days = daysUntil(l.examDate);
    let badge = '';
    if (days !== null && days >= 0 && days <= 7) {
      badge = `<span class="exam-soon">${days === 0 ? 'המבחן היום! 💪' : days === 1 ? 'המבחן מחר!' : `עוד ${days} ימים למבחן`}</span>`;
    }
    return `
      <div class="list-card" data-id="${l.id}">
        <span class="list-emoji">${emojis[i % emojis.length]}</span>
        <div class="list-info">
          <div class="list-name">${escapeHtml(l.name)}</div>
          <div class="list-sub">${l.words.length} מילים${l.examDate ? ' · מבחן ב־' + hebDayMonth(l.examDate) + ' (' + fmtDate(l.examDate) + ')' : ''}</div>
        </div>
        ${badge}
      </div>`;
  }).join('');
  container.querySelectorAll('.list-card').forEach(card => {
    card.addEventListener('click', () => {
      currentListId = card.dataset.id;
      renderListView();
      show('list');
    });
  });
}

/* ---------- Editor ---------- */

const wordRowsEl = document.getElementById('word-rows');

function addWordRow(en = '', he = '') {
  const row = document.createElement('div');
  row.className = 'word-row';
  row.innerHTML = `
    <input type="text" class="he-input" placeholder="עברית" value="${escapeHtml(he)}">
    <input type="text" class="en-input" placeholder="English" value="${escapeHtml(en)}"
           autocapitalize="off" spellcheck="false">
    <button class="remove-row" title="הסרה">✖</button>`;
  row.querySelector('.remove-row').addEventListener('click', () => row.remove());
  enforceLang(row.querySelector('.he-input'), () => 'he');
  enforceLang(row.querySelector('.en-input'), () => 'en');
  wordRowsEl.appendChild(row);
}

/* ---------- Editor exam date ---------- */

let editorDate = ''; // ISO string or ''

function renderEditorDate() {
  document.getElementById('date-display').textContent = editorDate ? fmtFullDate(editorDate) : 'עוד אין תאריך';
  document.getElementById('btn-clear-date').hidden = !editorDate;
}

document.getElementById('btn-pick-date').addEventListener('click', () => {
  openCalendar(editorDate, iso => { editorDate = iso; renderEditorDate(); });
});
document.getElementById('btn-clear-date').addEventListener('click', () => {
  editorDate = '';
  renderEditorDate();
});

function openEditor(listId = null) {
  editingListId = listId;
  const list = listId ? getList(listId) : null;
  document.getElementById('editor-title').textContent = list ? 'עריכת רשימה ✏️' : 'רשימה חדשה 📝';
  document.getElementById('list-name').value = list ? list.name : '';
  editorDate = list ? (list.examDate || '') : '';
  renderEditorDate();
  wordRowsEl.innerHTML = '';
  if (list) {
    list.words.forEach(w => addWordRow(w.en, w.he));
  } else {
    for (let i = 0; i < 10; i++) addWordRow();
  }
  show('editor');
}

document.getElementById('btn-new-list').addEventListener('click', () => openEditor());
document.getElementById('btn-add-row').addEventListener('click', () => addWordRow());
document.getElementById('btn-cancel-edit').addEventListener('click', () => {
  renderHome();
  show('home');
});

document.getElementById('btn-save-list').addEventListener('click', () => {
  const name = document.getElementById('list-name').value.trim();
  const examDate = editorDate;
  const words = [...wordRowsEl.querySelectorAll('.word-row')]
    .map(r => ({
      en: r.querySelector('.en-input').value.trim(),
      he: r.querySelector('.he-input').value.trim(),
    }))
    .filter(w => w.en && w.he);

  if (!name) { showAlert('צריך לתת שם לרשימה 😊'); return; }
  if (words.length === 0) { showAlert('צריך להוסיף לפחות מילה אחת (אנגלית + עברית) 😊'); return; }

  if (editingListId) {
    const list = getList(editingListId);
    list.name = name;
    list.examDate = examDate;
    list.words = words;
    currentListId = editingListId;
  } else {
    const list = {
      id: 'l' + Date.now(),
      name,
      examDate,
      createdAt: new Date().toISOString().slice(0, 10),
      words,
    };
    lists.push(list);
    currentListId = list.id;
  }
  saveLists(lists);
  renderListView();
  show('list');
});

/* ---------- List view ---------- */

function renderListView() {
  const list = getList(currentListId);
  if (!list) { renderHome(); show('home'); return; }
  document.getElementById('list-title').textContent = list.name;
  const days = daysUntil(list.examDate);
  let meta = list.examDate ? `📅 מבחן ב${fmtFullDate(list.examDate)}` : '';
  if (days !== null && days >= 0) {
    meta += days === 0 ? ' — היום! בהצלחה! 🍀' : days === 1 ? ' — מחר!' : ` — בעוד ${days} ימים`;
  }
  document.getElementById('list-meta').textContent = meta;

  const tbody = document.querySelector('#word-table tbody');
  tbody.innerHTML = list.words.map((w, i) => `
    <tr>
      <td>${escapeHtml(w.he)}</td>
      <td>${escapeHtml(w.en)}</td>
      <td><button class="row-speak" data-i="${i}">🔊</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('.row-speak').forEach(btn => {
    btn.addEventListener('click', () => speak(list.words[+btn.dataset.i].en));
  });
}

document.getElementById('btn-edit-list').addEventListener('click', () => openEditor(currentListId));

document.getElementById('btn-delete-list').addEventListener('click', () => {
  const list = getList(currentListId);
  showConfirm(`למחוק את "${list.name}"? אי אפשר להחזיר אחורה.`, '🗑️ כן, למחוק', () => {
    lists = lists.filter(l => l.id !== currentListId);
    saveLists(lists);
    renderHome();
    show('home');
  });
});

/* ---------- Practice engine ---------- */

const praise = ['כל הכבוד! 🌟', 'מעולה! 💜', 'איזו אלופה! 🏆', 'וואו, מדהים! ✨', 'יש! נכון! 🎉', 'פצצה! 💥', 'נהדר! 🦄'];
const praiseRetry = ['עכשיו נכון! כל הכבוד! ✍️', 'יופי, הצלחת לתקן! 💜', 'בדיוק! עכשיו זה מושלם! 🌟'];
const almostMsgs = ['כמעט!! יש טעות קטנטנה, נסי למצוא אותה 🔍', 'ממש קרוב! משהו קטן לא מדויק, נסי שוב 🤏', 'עוד רגע מושלם! בדקי שוב אות-אות 💫'];
const encourage = ['לא נורא, ננסה שוב! 💪', 'זה בסדר לטעות, ככה לומדים! 🌱', 'לא מדויק, אבל עוד ניסיון ויהיה מצוין! 🌈'];

let practice = null; // { mode, queue, index, correct, wrong, listId }

function startPractice(mode, words) {
  if (!words || words.length === 0) return;
  stopSpeech();
  practice = {
    mode,
    listId: currentListId,
    queue: shuffle(words),
    index: 0,
    correctCount: 0,
    wrong: [],
  };
  show('practice');
  showQuestion();
}

document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    if (mode === 'fill' || mode === 'write') return startSentenceMode(mode);
    const list = getList(currentListId);
    startPractice(mode, list.words);
  });
});

const questionWordEl = document.getElementById('question-word');
const answerInput = document.getElementById('answer-input');
const btnSpeak = document.getElementById('btn-speak');
const sentenceInput = document.getElementById('sentence-input');
const btnCheck = document.getElementById('btn-check');
const btnNext = document.getElementById('btn-next');
const feedbackEl = document.getElementById('feedback');

function showQuestion() {
  const { mode, queue, index } = practice;
  const word = queue[index];
  practice.firstTry = true;
  practice.answered = false;
  practice.checking = false;

  document.getElementById('progress-fill').style.width = (index / queue.length * 100) + '%';
  document.getElementById('practice-counter').textContent = `מילה ${index + 1} מתוך ${queue.length}`;

  feedbackEl.hidden = true;
  btnNext.hidden = true;
  btnCheck.hidden = false;
  btnCheck.textContent = 'בדיקה ✔';
  btnCheck.disabled = false;
  answerInput.value = '';
  answerInput.disabled = false;
  answerInput.className = '';
  answerInput.hidden = mode === 'write';
  sentenceInput.hidden = mode !== 'write';
  sentenceInput.value = '';
  sentenceInput.disabled = false;
  sentenceInput.className = 'en';

  if (mode === 'he2en') {
    questionWordEl.textContent = word.he;
    questionWordEl.className = 'question-word';
    btnSpeak.hidden = true;
    answerInput.classList.add('en');
    answerInput.placeholder = 'כתבי באנגלית...';
  } else if (mode === 'en2he') {
    questionWordEl.textContent = word.en;
    questionWordEl.className = 'question-word en';
    btnSpeak.hidden = true;
    answerInput.placeholder = 'כתבי בעברית...';
  } else if (mode === 'fill') {
    // the sentence, with the gap she has to fill
    questionWordEl.innerHTML =
      `<span class="sentence">${escapeHtml(word.sentence).replace('___', '<span class="blank">?</span>')}</span>`;
    questionWordEl.className = 'question-word';
    btnSpeak.hidden = true;
    answerInput.classList.add('en');
    answerInput.placeholder = 'איזו מילה חסרה?';
  } else if (mode === 'write') {
    questionWordEl.innerHTML =
      `<span class="write-prompt">כתבי משפט באנגלית עם המילה</span>
       <span class="en">${escapeHtml(word.en)}</span>
       <span class="write-he">(${escapeHtml(word.he)})</span>`;
    questionWordEl.className = 'question-word';
    btnSpeak.hidden = true;
  } else { // listen
    questionWordEl.textContent = '🎧';
    questionWordEl.className = 'question-word';
    btnSpeak.hidden = false;
    answerInput.classList.add('en');
    answerInput.placeholder = 'כתבי מה ששמעת...';
    speak(word.en);
  }
  (mode === 'write' ? sentenceInput : answerInput).focus();
}

btnSpeak.addEventListener('click', () => {
  speak(practice.queue[practice.index].en);
});

/* answer normalization: forgiving on case, extra spaces, Hebrew final letters */
function normEn(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
function normHe(s) {
  const finals = { 'ם': 'מ', 'ן': 'נ', 'ץ': 'צ', 'ף': 'פ', 'ך': 'כ' };
  return s.trim().replace(/\s+/g, ' ')
    .replace(/[֑-ׇ]/g, '') // strip nikud
    .replace(/[םןץףך]/g, c => finals[c]);
}
/* a stored answer may offer alternatives: "big / large" or "גדול, ענק" */
function matches(answer, stored, normalizer) {
  const a = normalizer(answer);
  return stored.split(/[,/]/).some(alt => normalizer(alt) === a);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

/* smallest edit distance between the answer and any stored alternative */
function minDistance(answer, stored, normalizer) {
  const a = normalizer(answer);
  return Math.min(...stored.split(/[,/]/).map(alt => levenshtein(a, normalizer(alt))));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* the word counts as a mistake once, however many tries it takes */
function markWrong(word) {
  if (practice.firstTry) {
    practice.firstTry = false;
    practice.wrong.push(word);
  }
}

function checkAnswer() {
  // once the word is right we're done with it - re-checking must never score again
  if (practice.answered) return;
  if (practice.mode === 'write') return checkWrittenSentence();

  const { mode, queue, index } = practice;
  const word = queue[index];
  const answer = answerInput.value;
  if (!answer.trim()) { answerInput.focus(); return; }

  const expectEn = mode !== 'en2he';
  // filling a gap: any word from the list that fits the sentence is right
  const stored = mode === 'fill' ? word.accept.join(',') : expectEn ? word.en : word.he;
  const reveal = mode === 'fill' ? word.en : stored;
  const norm = expectEn ? normEn : normHe;
  const ok = matches(answer, stored, norm);

  feedbackEl.hidden = false;
  btnNext.hidden = false;

  if (ok) {
    practice.answered = true;
    if (practice.firstTry) {
      practice.correctCount++;
      feedbackEl.textContent = pick(praise);
      burstConfetti(12);
    } else {
      feedbackEl.textContent = pick(praiseRetry);
      burstConfetti(6);
    }
    feedbackEl.className = 'feedback good';
    answerInput.classList.remove('wrong', 'almost');
    answerInput.classList.add('correct');
    answerInput.disabled = true;
    btnCheck.hidden = true;
    // hearing the whole sentence with the word in place is half the lesson
    if (mode === 'fill') speak(word.sentence.replace('___', answer.trim()));
    btnNext.focus();
    return;
  }

  // wrong - the word counts as a mistake once, but she can keep trying
  markWrong(word);

  const dist = minDistance(answer, mode === 'fill' ? reveal : stored, norm);
  const mainLen = norm((mode === 'fill' ? reveal : stored).split(/[,/]/)[0]).length;
  const minor = dist === 1 || (dist === 2 && mainLen >= 6);

  answerInput.classList.remove('wrong', 'almost');
  void answerInput.offsetWidth; // restart the shake animation
  if (minor) {
    answerInput.classList.add('almost');
    feedbackEl.className = 'feedback almost';
    feedbackEl.textContent = pick(almostMsgs);
  } else {
    answerInput.classList.add('wrong');
    feedbackEl.className = 'feedback bad';
    feedbackEl.innerHTML = `${pick(encourage)}
      <span class="correct-answer">${escapeHtml(reveal)}</span>`;
    const card = document.getElementById('question-card');
    card.classList.remove('flash-wrong');
    void card.offsetWidth;
    card.classList.add('flash-wrong');
    if (expectEn) speak(word.en);
    answerInput.select();
  }
  answerInput.focus();
}

btnCheck.addEventListener('click', checkAnswer);
answerInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    // don't let this Enter bubble to the document handler and skip the feedback
    e.stopPropagation();
    if (!answerInput.disabled) checkAnswer();
  }
});

btnNext.addEventListener('click', nextQuestion);
document.addEventListener('keydown', e => {
  // buttons handle Enter natively via click - avoid advancing twice
  if (e.key === 'Enter' && !btnNext.hidden && !screens.practice.hidden && e.target.tagName !== 'BUTTON') {
    nextQuestion();
  }
});

function nextQuestion() {
  if (practice.index >= practice.queue.length) return; // round already finished
  practice.index++;
  if (practice.index >= practice.queue.length) {
    showSummary();
  } else {
    showQuestion();
  }
}

/* ---------- "Write your own sentence" ----------
   The only exercise a computer can't mark on its own: whether a sentence is
   real English and uses the word for what it means. Cheap local checks run
   first so an obvious miss never costs a round trip. */

/* did she actually use the word? tokenising beats a regex here: it needs no
   escaping, and it will not match "cat" inside "cattle" */
function usesWord(sentence, word) {
  const w = normEn(word);
  const text = normEn(sentence);
  if (w.includes(' ')) return text.includes(w);
  return text.split(/[^a-z']+/).includes(w);
}

async function checkWrittenSentence() {
  const word = practice.queue[practice.index];
  const text = sentenceInput.value.trim();
  if (!text) { sentenceInput.focus(); return; }
  if (practice.checking) return;

  feedbackEl.hidden = false;
  btnNext.hidden = false;

  // she has to actually use the word - no need to ask the server about that
  if (!usesWord(text, word.en)) {
    markWrong(word);
    feedbackEl.className = 'feedback bad';
    feedbackEl.innerHTML = `צריך להשתמש במילה
      <span class="correct-answer">${escapeHtml(word.en)}</span> בתוך המשפט 🙂`;
    sentenceInput.classList.add('wrong');
    sentenceInput.focus();
    return;
  }

  practice.checking = true;
  btnCheck.disabled = true;
  btnCheck.textContent = 'בודקים... ⏳';
  feedbackEl.className = 'feedback';
  feedbackEl.textContent = 'קוראים את המשפט שלך... 👀';

  let res = null;
  try {
    const r = await fetch('api/sentence-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: word.en, sentence: text }),
    });
    if (r.ok) res = await r.json();
  } catch {}

  practice.checking = false;
  btnCheck.disabled = false;
  btnCheck.textContent = 'בדיקה ✔';

  // couldn't reach the marker: don't score it either way, just let her carry on
  if (!res || !res.verdict) {
    feedbackEl.className = 'feedback almost';
    feedbackEl.textContent = 'לא הצלחנו לבדוק את המשפט עכשיו 😕 אפשר להמשיך הלאה';
    return;
  }

  const correction = res.correction && normEn(res.correction) !== normEn(text)
    ? `<span class="correction">${escapeHtml(res.correction)}</span>` : '';

  if (res.verdict === 'great') {
    practice.answered = true;
    if (practice.firstTry) {
      practice.correctCount++;
      burstConfetti(12);
    } else {
      burstConfetti(6);
    }
    feedbackEl.className = 'feedback good';
    feedbackEl.innerHTML = `${escapeHtml(res.feedback || pick(praise))}`;
    sentenceInput.classList.remove('wrong', 'almost');
    sentenceInput.classList.add('correct');
    sentenceInput.disabled = true;
    btnCheck.hidden = true;
    btnNext.focus();
    return;
  }

  markWrong(word);
  const almost = res.verdict === 'almost';
  sentenceInput.classList.remove('wrong', 'almost');
  void sentenceInput.offsetWidth; // restart the shake
  sentenceInput.classList.add(almost ? 'almost' : 'wrong');
  feedbackEl.className = almost ? 'feedback almost' : 'feedback bad';
  feedbackEl.innerHTML = escapeHtml(res.feedback || '') + correction;
  sentenceInput.focus();
}

sentenceInput.addEventListener('keydown', e => {
  // Enter sends the sentence; Shift+Enter is a new line
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.stopPropagation();
    if (!sentenceInput.disabled) checkAnswer();
  }
});

/* ---------- Sentence bank ----------
   Sentences for a list are written once by the server and then frozen. We keep
   a copy in localStorage so a round plays fine with no network, and so the same
   sentence doesn't come round again until the others have had their turn. */

const bankCache = {};

function loadBankLocal(listId) {
  try { return JSON.parse(localStorage.getItem('bank:' + listId)) || null; } catch { return null; }
}
function saveBankLocal(listId, words) {
  try { localStorage.setItem('bank:' + listId, JSON.stringify(words)); } catch {}
}

const prepOverlay = document.getElementById('prep-overlay');
const prepMsg = document.getElementById('prep-msg');
const prepFill = document.getElementById('prep-fill');
let prepCancelled = false;

document.getElementById('prep-cancel').addEventListener('click', () => {
  prepCancelled = true;
  prepOverlay.hidden = true;
});

function showPrep(done, total) {
  prepOverlay.hidden = false;
  prepMsg.textContent = total
    ? `מכינים משפטים לרשימה... ${done} מתוך ${total} מילים`
    : 'מכינים משפטים לרשימה...';
  prepFill.style.width = total ? (done / total * 100) + '%' : '5%';
}

/* Fetch what exists, then ask the server to write the missing words in small
   batches. `quiet` runs it in the background with no overlay. */
async function ensureSentences(listId, { quiet = false } = {}) {
  const r = await fetch('api/sentences?listId=' + encodeURIComponent(listId));
  if (!r.ok) throw new Error(r.status === 503 ? 'unconfigured' : 'offline');
  let state = await r.json();
  const total = Object.keys(state.words).length + state.remaining;

  prepCancelled = false;
  while (!state.ready) {
    if (prepCancelled) break;
    if (!quiet) showPrep(Object.keys(state.words).length, total);
    const res = await fetch('api/sentences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listId }),
    });
    if (!res.ok) { if (!quiet) prepOverlay.hidden = true; throw new Error('generation failed'); }
    const next = await res.json();
    // no progress at all means the server can't do these words - don't spin
    if (next.stuck) { state = next; break; }
    state = next;
  }
  if (!quiet) prepOverlay.hidden = true;
  bankCache[listId] = state.words;
  saveBankLocal(listId, state.words);
  return state.words;
}

/* The sentences for a word, in a rotation that doesn't repeat until they've
   all been used. */
function pickSentence(listId, key, sentences) {
  const seenKey = `seen:${listId}:${key}`;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(seenKey)) || []; } catch {}
  if (seen.length >= sentences.length) seen = [];
  const fresh = sentences.map((s, i) => i).filter(i => !seen.includes(i));
  const pick = fresh[Math.floor(Math.random() * fresh.length)];
  try { localStorage.setItem(seenKey, JSON.stringify([...seen, pick])); } catch {}
  return sentences[pick];
}

/* Build a practice queue of words that have a sentence ready. */
function sentenceQueue(listId, words, bank) {
  return words
    .map(w => {
      const entry = bank[normEn(w.en)];
      if (!entry || !entry.sentences || !entry.sentences.length) return null;
      const sentence = pickSentence(listId, normEn(w.en), entry.sentences);
      return { ...w, sentence: sentence.text, accept: sentence.accept };
    })
    .filter(Boolean);
}

async function startSentenceMode(mode) {
  const list = getList(currentListId);
  if (!list) return;
  if (mode === 'write') {
    // nothing to prepare - but it does need the server, so say so up front
    startPractice('write', list.words);
    return;
  }
  let bank = bankCache[currentListId] || loadBankLocal(currentListId);
  const missing = !bank || list.words.some(w => !bank[normEn(w.en)]);
  if (missing) {
    try {
      bank = await ensureSentences(currentListId);
    } catch (e) {
      if (!bank) {
        showAlert(e.message === 'unconfigured'
          ? 'המשפטים עוד לא מוכנים 😕 חסרה הגדרה בשרת'
          : 'לא הצלחנו להכין משפטים עכשיו 😕 אפשר לנסות שוב מאוחר יותר');
        return;
      }
    }
  }
  const queue = sentenceQueue(currentListId, list.words, bank || {});
  if (!queue.length) {
    showAlert('אין עדיין משפטים לרשימה הזאת 😕');
    return;
  }
  startPractice('fill', queue);
}

/* ---------- Summary ---------- */

function showSummary() {
  stopSpeech();
  const total = practice.queue.length;
  const correct = practice.correctCount;
  const pct = correct / total;

  const starsEl = document.getElementById('summary-stars');
  const titleEl = document.getElementById('summary-title');
  if (pct === 1) {
    starsEl.textContent = '⭐⭐⭐';
    titleEl.textContent = 'מושלם!!! את אלופת האנגלית! 👑';
    burstConfetti(60);
  } else if (pct >= 0.8) {
    starsEl.textContent = '⭐⭐';
    titleEl.textContent = 'כמעט מושלם! עבודה נהדרת! 🎉';
    burstConfetti(30);
  } else if (pct >= 0.5) {
    starsEl.textContent = '⭐';
    titleEl.textContent = 'יופי של התקדמות! 🌟';
  } else {
    starsEl.textContent = '🌱';
    titleEl.textContent = 'התחלה טובה! עוד תרגול קטן ותהיי אלופה!';
  }
  document.getElementById('summary-score').textContent = `ענית נכון על ${correct} מתוך ${total} מילים`;

  const mistakesEl = document.getElementById('summary-mistakes');
  if (practice.wrong.length > 0) {
    mistakesEl.innerHTML = '<h3>מילים לחזרה 📖</h3><table>' +
      practice.wrong.map(w => `<tr><td>${escapeHtml(w.he)}</td><td class="en">${escapeHtml(w.en)}</td></tr>`).join('') +
      '</table>';
  } else {
    mistakesEl.innerHTML = '';
  }
  document.getElementById('btn-retry-wrong').hidden = practice.wrong.length === 0;
  show('summary');
}

document.getElementById('btn-retry-wrong').addEventListener('click', () => {
  startPractice(practice.mode, practice.wrong);
});
document.getElementById('btn-practice-again').addEventListener('click', () => {
  startPractice(practice.mode, getList(practice.listId).words);
});
document.getElementById('btn-back-home').addEventListener('click', () => {
  currentListId = practice.listId;
  renderListView();
  show('list');
});

/* ---------- Confetti ---------- */

const confettiLayer = document.getElementById('confetti-layer');
const confettiChars = ['🎉', '⭐', '💜', '🌸', '✨', '🩷', '🦄'];

function burstConfetti(n) {
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'confetti';
    el.textContent = confettiChars[Math.floor(Math.random() * confettiChars.length)];
    el.style.left = Math.random() * 100 + 'vw';
    el.style.animationDuration = (1.5 + Math.random() * 1.5) + 's';
    el.style.animationDelay = (Math.random() * 0.4) + 's';
    confettiLayer.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
}

/* ---------- Backup (export / import) ---------- */

document.getElementById('btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(lists, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'english-words-backup.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error();
      // merge: keep existing lists, add ones with new ids
      const existingIds = new Set(lists.map(l => l.id));
      data.forEach(l => { if (!existingIds.has(l.id)) lists.push(l); });
      saveLists(lists);
      renderHome();
      showAlert('הגיבוי נטען בהצלחה! 🎉');
    } catch {
      showAlert('אופס, הקובץ לא תקין 😕');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ---------- Keyboard language magic ----------
   Each input knows which language it needs. When magic is on, keystrokes made
   with the "wrong" keyboard layout are converted using the standard Israeli
   Hebrew <-> QWERTY key positions, so the right letters always come out. */

const HE_TO_EN = {
  'ק': 'e', 'ר': 'r', 'א': 't', 'ט': 'y', 'ו': 'u', 'ן': 'i', 'ם': 'o', 'פ': 'p',
  'ש': 'a', 'ד': 's', 'ג': 'd', 'כ': 'f', 'ע': 'g', 'י': 'h', 'ח': 'j', 'ל': 'k', 'ך': 'l',
  'ז': 'z', 'ס': 'x', 'ב': 'c', 'ה': 'v', 'נ': 'b', 'מ': 'n', 'צ': 'm', 'ת': ',', 'ץ': '.',
};
const EN_TO_HE = {};
Object.entries(HE_TO_EN).forEach(([he, en]) => { EN_TO_HE[en] = he; });

let kbdMagic = localStorage.getItem('kbd-magic') !== 'off';
const kbdMagicBtn = document.getElementById('kbd-magic');

function renderKbdMagic() {
  kbdMagicBtn.textContent = kbdMagic ? '⌨️✨ קסם שפה: פועל' : '⌨️ קסם שפה: כבוי';
  kbdMagicBtn.classList.toggle('off', !kbdMagic);
}
kbdMagicBtn.addEventListener('click', () => {
  kbdMagic = !kbdMagic;
  localStorage.setItem('kbd-magic', kbdMagic ? 'on' : 'off');
  renderKbdMagic();
});
renderKbdMagic();

function insertChar(input, ch) {
  input.setRangeText(ch, input.selectionStart, input.selectionEnd, 'end');
}

function enforceLang(input, getLang) {
  input.addEventListener('keydown', e => {
    if (!kbdMagic || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
    const lang = getLang();
    if (lang === 'en') {
      const mapped = HE_TO_EN[e.key];
      if (mapped && /[a-z]/.test(mapped)) {
        e.preventDefault();
        insertChar(input, mapped);
      }
    } else if (lang === 'he') {
      const mapped = EN_TO_HE[e.key.toLowerCase()];
      if (mapped) {
        e.preventDefault();
        insertChar(input, mapped);
      }
    }
  });
}

enforceLang(answerInput, () => (practice && practice.mode === 'en2he') ? 'he' : 'en');

/* ---------- Hebrew calendar picker ---------- */

const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

let calOnPick = null;
let calSelectedIso = '';
let calViewDate = new Date(); // any date inside the displayed Hebrew month

const calOverlay = document.getElementById('heb-cal-overlay');

document.getElementById('cal-weekdays').innerHTML =
  WEEKDAYS_HE.map(d => `<div>${d.length > 5 ? d.slice(0, 5) : d}</div>`).join('');

function openCalendar(selectedIso, onPick) {
  calOnPick = onPick;
  calSelectedIso = selectedIso || '';
  calViewDate = selectedIso ? dateOfIso(selectedIso) : new Date();
  renderCalendar();
  calOverlay.hidden = false;
}

function closeCalendar() {
  calOverlay.hidden = true;
}

document.getElementById('cal-close').addEventListener('click', closeCalendar);
calOverlay.addEventListener('click', e => { if (e.target === calOverlay) closeCalendar(); });

function renderCalendar() {
  // find the Gregorian date of the 1st of the displayed Hebrew month
  let first = new Date(calViewDate);
  first.setHours(12, 0, 0, 0);
  while (hebParts(first).day > 1) first = addDays(first, -1);
  const monthName = hebFmtHeMonth.format(first);
  const yearName = hebYearName(first);

  // collect all days of this Hebrew month (29 or 30)
  const days = [];
  let d = first;
  const monthKey = hebParts(first).month;
  while (hebParts(d).month === monthKey) {
    days.push(d);
    d = addDays(d, 1);
  }
  const last = days[days.length - 1];

  const gregSpan = first.getMonth() === last.getMonth()
    ? `${MONTHS_HE[first.getMonth()]} ${first.getFullYear()}`
    : `${MONTHS_HE[first.getMonth()]}${first.getFullYear() === last.getFullYear() ? '' : ' ' + first.getFullYear()} - ${MONTHS_HE[last.getMonth()]} ${last.getFullYear()}`;
  document.getElementById('cal-title').innerHTML =
    `${monthName} ${yearName}<span class="cal-greg">${gregSpan}</span>`;

  const todayIso = isoOf(new Date());
  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  const addEmpty = () => {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    grid.appendChild(empty);
  };
  for (let i = 0; i < first.getDay(); i++) addEmpty();
  days.forEach(day => {
    const hp = hebParts(day);
    const holiday = holidayFor(day, hp);
    const iso = isoOf(day);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day';
    if (day.getDay() === 6) cell.classList.add('shabbat');
    if (holiday) cell.classList.add('has-holiday');
    if (iso === todayIso) cell.classList.add('today');
    if (iso === calSelectedIso) cell.classList.add('selected');
    cell.innerHTML = `
      <span class="heb-day">${gematria(hp.day)}</span>
      <span class="greg-day">${day.getDate()}.${day.getMonth() + 1}</span>
      ${holiday ? `<span class="holiday">${holiday}</span>` : ''}`;
    cell.addEventListener('click', () => {
      if (calOnPick) calOnPick(iso);
      closeCalendar();
    });
    grid.appendChild(cell);
  });
  // always 6 rows so the calendar keeps the same size in every month
  while (grid.children.length < 42) addEmpty();

  // RTL time direction: ❮ (left) = forward to next month, ❯ (right) = back
  document.getElementById('cal-nav-next').onclick = () => { calViewDate = addDays(last, 1); renderCalendar(); };
  document.getElementById('cal-nav-prev').onclick = () => { calViewDate = addDays(first, -1); renderCalendar(); };
}

/* ---------- Google sign-in / multi-user ---------- */

const authArea = document.getElementById('auth-area');
let gisReady = false;

function renderAuthUi() {
  if (currentUser) {
    authArea.innerHTML = `
      ${currentUser.picture ? `<img class="avatar" src="${escapeHtml(currentUser.picture)}" alt="">` : ''}
      <span>שלום, ${escapeHtml(currentUser.name)}! ☁️</span>
      <button id="btn-logout" class="tiny-btn">יציאה</button>`;
    document.getElementById('btn-logout').addEventListener('click', logout);
  } else {
    authArea.innerHTML = '';
    // login is mandatory: the sign-in button lives on the gate screen
    const holder = document.getElementById('gsi-btn-gate');
    if (holder && gisReady) {
      holder.innerHTML = '';
      google.accounts.id.renderButton(holder,
        { theme: 'filled_blue', size: 'large', shape: 'pill', locale: 'he' });
    }
  }
}

function loadGis() {
  if (!GOOGLE_CLIENT_ID) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
    gisReady = true;
    renderAuthUi();
  };
  document.head.appendChild(s);
}

async function onGoogleCredential(resp) {
  try {
    const r = await fetch('api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: resp.credential }),
    });
    if (!r.ok) { showAlert('ההתחברות נכשלה 😕 נסו שוב'); return; }
    currentUser = await r.json();
    await loadCloudLists();
  } catch {
    showAlert('ההתחברות נכשלה 😕 נסו שוב');
  }
}

async function loadCloudLists() {
  try {
    const r = await fetch('api/lists');
    if (r.ok) {
      const cloud = (await r.json()).lists || [];
      const local = loadLists();
      if (cloud.length === 0 && local.length > 0) {
        // first sign-in on this device: copy the local lists into the account
        lists = local;
        await pushCloudLists();
      } else {
        lists = cloud;
      }
    }
  } catch {}
  renderAuthUi();
  renderHome();
  show('home');
}

async function logout() {
  try { await fetch('api/logout', { method: 'POST' }); } catch {}
  currentUser = null;
  lists = [];
  renderAuthUi();
  show('login');
}

async function initAuth() {
  loadGis();
  try {
    const r = await fetch('api/me');
    if (r.ok) {
      currentUser = await r.json();
      await loadCloudLists();
      return;
    }
  } catch {}
  renderAuthUi();
  show('login');
}

/* ---------- Init ---------- */

show('login');
initAuth();
