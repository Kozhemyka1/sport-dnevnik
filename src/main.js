import {
  START_DATE, DAY_NAMES, DAY_ORDER, TAB_ORDER, REAL_TO_PROG, DESCR,
  WARMUP, COOLDOWN, RULES, MEASUREMENTS, GLOSSARY, STARTER_WEEKS,
} from './data.js';

const LS_KEY = 'sportlog.v1';

/* ---------- хранилище ---------- */
function loadStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      return {
        entries: Array.isArray(d.entries) ? d.entries : [],
        meas: d.meas || {},
        done: d.done || {},          // отметки выполнения: "неделя:день" -> {status, date}
        startDate: d.startDate || null, // якорь старта цикла (ISO)
      };
    }
  } catch (e) { /* повреждённые данные — начинаем с чистого */ }
  return { entries: [], meas: {}, done: {}, startDate: null };
}
function saveLocal() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
function saveStore() {
  saveLocal();
  queuePush();
}
let store = loadStore();

/* ---------- тема оформления ---------- */
const THEMES = {
  term:  { name: 'ТЕРМИНАЛ', sw: '#7dd87d', bg: '#000000' },
  amber: { name: 'ЯНТАРЬ',   sw: '#ffb000', bg: '#000000' },
  blue:  { name: 'СИНЯЯ',    sw: '#4da3ff', bg: '#000000' },
  pink:  { name: 'РОЗОВАЯ',  sw: '#ff5cb8', bg: '#000000' },
  light: { name: 'СВЕТЛАЯ',  sw: '#1d7a2f', bg: '#f2f2ec' },
};
let curTheme = localStorage.getItem('sportlog.theme') || 'term';
let curFont = localStorage.getItem('sportlog.font') || 'px';
if (!THEMES[curTheme]) curTheme = 'term';
function applyTheme() {
  document.body.dataset.theme = curTheme;
  document.body.dataset.font = curFont;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEMES[curTheme].bg;
}
applyTheme();

/* ---------- синхронизация с сервером ---------- */
const remote = {
  token: localStorage.getItem('sportlog.token') || null,
  login: localStorage.getItem('sportlog.login') || null,
  online: false,
};
let programOverride = loadProgLocal(); // программа аккаунта (локальная копия)
const PROG = () => programOverride;

function loadProgLocal() {
  try { return JSON.parse(localStorage.getItem('sportlog.prog') || 'null'); }
  catch (e) { return null; }
}
function saveProgLocal() {
  if (programOverride) localStorage.setItem('sportlog.prog', JSON.stringify(programOverride));
  else localStorage.removeItem('sportlog.prog');
}

let progTimer = null;
function queueProgPush() {
  if (!remote.token) return;
  clearTimeout(progTimer);
  progTimer = setTimeout(async () => {
    try { await pushState({ program: programOverride }); }
    catch (e) { remote.online = false; }
  }, 800);
}
function saveProgram() { saveProgLocal(); queueProgPush(); }

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (remote.token) headers['Authorization'] = 'Bearer ' + remote.token;
  return fetch(path, { ...opts, headers });
}

async function pushState(patch) {
  if (!remote.token) return;
  const r = await api('/api/state', { method: 'PUT', body: JSON.stringify(patch) });
  if (r.status === 401) { dropToken(); return; }
  if (!r.ok) throw new Error('push failed');
  remote.online = true;
}

let pushTimer = null;
function queuePush() {
  if (!remote.token) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try { await pushState({ diary: store }); }
    catch (e) { remote.online = false; } // офлайн — допушим при следующей записи
  }, 800);
}

function dropToken() {
  remote.token = null; remote.online = false;
  localStorage.removeItem('sportlog.token');
}

async function syncInit() {
  if (!remote.token) return;
  try {
    const r = await api('/api/state');
    if (r.status === 401) { dropToken(); return; }
    if (!r.ok) return;
    remote.online = true;
    const state = await r.json();
    if (state.program && Array.isArray(state.program) && state.program.length) {
      programOverride = state.program;
      saveProgLocal();
      if (curWeek > state.program.length) curWeek = state.program.length;
    } else if (programOverride && programOverride.length) {
      await pushState({ program: programOverride }); // на сервере пусто — заливаем локальную программу
    }
    // если программы нет нигде — остаётся пустая, пользователь соберёт сам
    const sd = state.diary;
    const serverHasDiary = !!(sd && (
      (Array.isArray(sd.entries) && sd.entries.length) || sd.startDate ||
      (sd.done && Object.keys(sd.done).length)));
    if (serverHasDiary) {  // сервер новее локального — сервер главный
      store = {
        entries: sd.entries || [],
        meas: sd.meas || {},
        done: sd.done || {},
        startDate: sd.startDate || null,
      };
      saveLocal();
    } else if (store.entries.length || store.startDate || Object.keys(store.done).length) {
      await pushState({ diary: store }); // на сервере пусто — заливаем локальный дневник
    }
  } catch (e) { remote.online = false; }
}

async function doLogin(login, password) {
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ login, password }) });
  if (r.status === 429) throw new Error('Много попыток — подожди минуту');
  if (!r.ok) throw new Error('Неверный логин или пароль');
  const d = await r.json();
  remote.token = d.token; remote.login = login;
  localStorage.setItem('sportlog.token', d.token);
  localStorage.setItem('sportlog.login', login);
  await syncInit();
  curWeek = TODAY.week; curView = TODAY.day; // якорь мог приехать с сервером — переоткрываем на сегодня
  render();
}

async function doLogout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
  dropToken();
  localStorage.removeItem('sportlog.login');
  remote.login = null;
  editMode = false;
  render();
}

/* ---------- даты ---------- */
const DAY_MS = 86400000;
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function anchorIso() { return store.startDate || START_DATE; }
function anchorDate() { return new Date(anchorIso() + 'T00:00:00'); }
// дата ячейки вкладки i (0..6) выбранной недели curWeek
function tabDate(i, week = curWeek) {
  return new Date(anchorDate().getTime() + ((week - 1) * 7 + i) * DAY_MS);
}
const WD = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
function tabLabel(i, week) { return WD[tabDate(i, week).getDay()]; }
function todayInfo() {
  const start = anchorDate();
  const now = new Date();
  const diff = Math.floor((new Date(iso(now) + 'T00:00:00') - start) / DAY_MS);
  const total = (PROG() || []).length * 7 || 28;
  if (diff >= 0 && diff < total) {
    return { week: Math.floor(diff / 7) + 1, day: TAB_ORDER[diff % 7], inPlan: true };
  }
  return { week: 1, day: DAY_ORDER[(now.getDay() + 6) % 7], inPlan: false };
}
// пересчитывается при каждом обращении (якорь может прийти с сервера после syncInit)
const TODAY = new Proxy({}, { get: (_, p) => todayInfo()[p] });

/* ---------- состояние ---------- */
let curWeek = TODAY.week;
let curView = TODAY.day; // mon..sun | 'diary' | 'info'
let editMode = false;

/* ---------- шаблоны для редактора программы ---------- */
const newExercise = () => ({ n: 'Новое упражнение', s: '3×10', w: true });
const newBlock = () => ({ t: 'Основная часть', items: [] });
const newDay = title => ({ title, focus: '', dur: '', blocks: [newBlock()] });
const newWeek = n => ({
  n, theme: 'Новая неделя', rpe: '', hint: '',
  days: {
    d1: newDay('День 1'), d2: newDay('День 2'), d3: newDay('День 3'), d4: newDay('День 4'),
    rest: { title: 'Отдых + мобилити', focus: 'Восстановление', dur: '', rest: true, blocks: [] },
  },
});
function renumberWeeks(p) { p.forEach((w, i) => { w.n = i + 1; }); }

/* ---------- DOM ---------- */
const $view = document.getElementById('view');
const $weekNav = document.getElementById('weekNav');
const $dayNav = document.getElementById('dayNav');
const $modalRoot = document.getElementById('modalRoot');
const $toast = document.getElementById('toast');

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  setTimeout(() => $toast.classList.remove('show'), 1600);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- шапка с датой ---------- */
function renderDate() {
  const now = new Date();
  const P = PROG() || [];
  document.getElementById('dateNow').innerHTML =
    `<b>${WD[now.getDay()]}</b> ${iso(now).split('-').reverse().join('.')}` +
    (TODAY.inPlan ? `<br>неделя <b>${TODAY.week}</b> из ${P.length || 4}` : `<br>вне плана`);
}

/* ---------- навигация ---------- */
function renderNav() {
  const P = PROG() || [];
  $weekNav.innerHTML = P.map(w =>
    `<button class="navbtn ${w.n === curWeek ? 'active' : ''} ${w.n === TODAY.week && TODAY.inPlan ? 'today-mark' : ''}" data-week="${w.n}">
      НЕД ${w.n}<small>${esc(w.theme)}</small>
    </button>`).join('') +
    `<button class="navbtn editbtn ${editMode ? 'active' : ''}" data-edit="1" title="Режим правки программы">✎</button>`;
  $weekNav.querySelectorAll('[data-week]').forEach(b =>
    b.addEventListener('click', () => { curWeek = +b.dataset.week; if (curView === 'diary' || curView === 'info' || curView === 'import' || curView === 'stats') curView = TODAY.day; render(); }));
  $weekNav.querySelector('[data-edit]').addEventListener('click', () => { editMode = !editMode; render(); });

  const todayIso = iso(new Date());
  const dayBtns = TAB_ORDER.map((d, i) => {
    const mark = iso(tabDate(i)) === todayIso ? 'today-mark' : '';
    const pk = REAL_TO_PROG[d];
    const st = pk && pk !== 'rest' ? store.done[curWeek + ':' + pk] : null;
    const badge = st ? `<small class="stmark">${st.status === 'done' ? '✓' : '✗'}</small>` : '';
    return `<button class="navbtn ${d === curView ? 'active' : ''} ${mark}" data-day="${d}">${tabLabel(i)}${badge}</button>`;
  }).join('');
  $dayNav.innerHTML = dayBtns +
    `<button class="navbtn ${curView === 'diary' ? 'active' : ''}" data-day="diary">ДНЕВ<br>НИК</button>` +
    `<button class="navbtn ${curView === 'stats' ? 'active' : ''}" data-day="stats">СТАТ</button>` +
    `<button class="navbtn ${curView === 'info' ? 'active' : ''}" data-day="info">ИНФО</button>` +
    `<button class="navbtn ${curView === 'import' ? 'active' : ''}" data-day="import">ИМП<br>ОРТ</button>`;
  $dayNav.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { curView = b.dataset.day; render(); }));
}

/* ---------- последний лог по упражнению ---------- */
function lastLog(name) {
  for (let i = store.entries.length - 1; i >= 0; i--) {
    if (store.entries[i].exName === name) return store.entries[i];
  }
  return null;
}

/* ---------- курсор выполнения ---------- */
const PROG_TO_TAB = { d1: 'tue', d2: 'thu', d3: 'sat', d4: 'sun' };
function dayStatus(week, progKey) { return store.done[week + ':' + progKey] || null; }
function setDayStatus(week, progKey, status) {
  const k = week + ':' + progKey;
  if (status) store.done[k] = { status, date: iso(new Date()) };
  else delete store.done[k];
  saveStore(); render();
}
// первый невыполненный тренировочный день программы — «текущий» по факту
function cursorInfo() {
  const P = PROG() || [];
  for (const w of P) {
    for (const pk of ['d1', 'd2', 'd3', 'd4']) {
      const dd = w.days[pk];
      if (!dd || dd.rest) continue;
      if (!dayStatus(w.n, pk)) return { week: w.n, progKey: pk, title: dd.title };
    }
  }
  return null;
}

/* ---------- рендер дня ---------- */
function exRow(ex, wn, d, bi, ei) {
  const id = `w${wn}-${d}-${bi}-${ei}`;
  const last = lastLog(ex.n);
  return `<div class="ex" data-exid="${id}">
    <div class="ex-row">
      <span class="ex-name">${esc(ex.n)}</span>
      <span class="ex-scheme">${esc(ex.s)}</span>
      <button class="qbtn" data-q="${esc(ex.n)}" title="Описание упражнения" aria-label="Описание: ${esc(ex.n)}">?</button>
    </div>
    ${ex.w ? `<div class="logrow">
      <label for="w-${id}">вес, кг</label>
      <input id="w-${id}" inputmode="decimal" placeholder="—" data-weight>
      <input class="note" placeholder="заметка" data-note>
      <button class="logbtn" data-log="${id}" data-name="${esc(ex.n)}">ЗАПИСАТЬ</button>
      ${last ? `<span class="lastlog">последнее: <b>${esc(last.weight || '—')}${last.weight ? ' кг' : ''}</b> ${last.note ? '· ' + esc(last.note) : ''} · ${last.date.slice(8)}.${last.date.slice(5, 7)}</span>` : ''}
    </div>` : (last ? `<div class="logrow"><span class="lastlog">в дневнике: <b>${esc(last.weight || '')}${last.weight ? ' кг' : ''}</b> ${last.note ? esc(last.note) : ''}</span></div>` : '')}
  </div>`;
}

function renderDay() {
  const P = PROG() || [];
  const wk = P[curWeek - 1];

  if (!wk) {
    $view.innerHTML = `<section class="block px"><div class="empty">
      ПРОГРАММА ПУСТАЯ<br><br>загрузи свою из файла<br>или начни со стартового шаблона</div></section>
      <div class="toolbar">
        <button class="toolbtn" id="btnImportProg">▲ ИМПОРТ ИЗ ФАЙЛА</button>
        <button class="toolbtn" id="btnLoadBase">▼ СТАРТОВЫЙ ШАБЛОН</button>
        <button class="toolbtn" id="btnNewWeek">+ ПУСТАЯ НЕДЕЛЯ</button>
      </div>`;
    document.getElementById('btnNewWeek').addEventListener('click', () => {
      programOverride = [newWeek(1)];
      store.done = {}; store.startDate = iso(new Date()); saveStore(); // цикл начинается сегодня
      curWeek = 1; curView = TODAY.day; saveProgram(); render();
    });
    document.getElementById('btnLoadBase').addEventListener('click', () => {
      programOverride = JSON.parse(JSON.stringify(STARTER_WEEKS));
      store.done = {}; store.startDate = iso(new Date()); saveStore();
      curWeek = 1; curView = TODAY.day; saveProgram(); render();
      toast('ШАБЛОН ЗАГРУЖЕН ▼');
    });
    document.getElementById('btnImportProg').addEventListener('click', () =>
      document.getElementById('progFile').click());
    return;
  }

  const progKeyOwn = REAL_TO_PROG[curView] || curView;
  const tabIdx = TAB_ORDER.indexOf(curView);
  const tabDt = tabDate(tabIdx);
  const todayIso = iso(new Date());
  const isToday = iso(tabDt) === todayIso;

  if (editMode) { renderDayEdit(P, wk, wk.days[progKeyOwn] || wk.days.rest); return; }

  // курсор: первый невыполненный день; просроченный — всплывает на сегодня
  const cursor = cursorInfo();
  let cursorDateIso = null;
  if (cursor) cursorDateIso = iso(tabDate(TAB_ORDER.indexOf(PROG_TO_TAB[cursor.progKey]), cursor.week));
  const trainedToday = Object.values(store.done).some(s => s.date === todayIso);
  // одна тренировка в день: если сегодня уже выполнено/пропущено — не всплываем
  const floatActive = !!(cursor && cursorDateIso < todayIso && !trainedToday && TODAY.inPlan);
  const floatHere = floatActive && isToday;

  let effWeek = curWeek, wkEff = wk, progKey = progKeyOwn;
  let d = wk.days[progKeyOwn] || wk.days.rest;
  let movedNote = '';
  if (floatHere) {
    effWeek = cursor.week; wkEff = P[cursor.week - 1]; progKey = cursor.progKey;
    d = wkEff.days[progKey] || wkEff.days.rest;
    movedNote = `перенесено с ${cursorDateIso.slice(8)}.${cursorDateIso.slice(5, 7)} · день ${cursor.progKey.slice(1)} недели ${cursor.week}`;
  }

  const isCursor = !!(cursor && cursor.week === effWeek && cursor.progKey === progKey && !d.rest);
  const isOldCursorCell = isCursor && floatActive && !isToday;
  const badge = isToday ? '<span class="today-badge">СЕГОДНЯ</span>'
    : isOldCursorCell ? '<span class="today-badge cursor-badge">→ ПЕРЕНЕСЁН</span>'
    : isCursor ? '<span class="today-badge cursor-badge">ТЕКУЩИЙ</span>' : '';
  const dateLbl = `${tabLabel(tabIdx)} ${String(tabDt.getDate()).padStart(2, '0')}.${String(tabDt.getMonth() + 1).padStart(2, '0')}`;

  let html = `<div class="weekinfo px">
    <span class="theme">Неделя ${wkEff.n} — ${esc(wkEff.theme)}</span>
    <span class="rpe">${esc(wkEff.rpe)}</span>
    <span class="hint">${esc(wkEff.hint)}</span>
  </div>
  <div class="dayhead px">
    <h2>${esc(d.title)}${badge}</h2>
    <div class="meta"><span><b>${dateLbl}</b> · день ${tabIdx + 1} программы</span><span>фокус: <b>${esc(d.focus)}</b></span><span>время: <b>${esc(d.dur)}</b></span></div>
  </div>`;

  if (movedNote) {
    html += `<div class="donebar px"><span class="donestatus wait">${esc(movedNote)}</span></div>`;
  }

  // панель выполнения на тренировочном дне
  if (!d.rest && progKey !== 'rest') {
    const st = dayStatus(effWeek, progKey);
    if (!st) {
      html += `<div class="donebar px">
        <button class="toolbtn" data-done="done">■ ВЫПОЛНЕНО</button>
        <button class="toolbtn" data-done="skipped">✗ ПРОПУСТИТЬ</button>
      </div>`;
    } else {
      const lbl = st.status === 'done'
        ? `■ ВЫПОЛНЕНО ${st.date.slice(8)}.${st.date.slice(5, 7)}`
        : '✗ ПРОПУЩЕН';
      html += `<div class="donebar px"><span class="donestatus ${st.status}">${lbl}</span>
        <button class="toolbtn" data-done="">ОТМЕНИТЬ</button></div>`;
    }
  }
  if (isToday && !cursor && P.length) {
    html += `<div class="donebar px"><span class="donestatus done">ЦИКЛ ЗАВЕРШЁН ■ все тренировки выполнены</span></div>`;
  }

  if (d.rest && !d.blocks.length) {
    html += `<section class="block px"><div class="restbox"><div class="big">ОТДЫХ<br><br>сон · еда · прогулка<br>мягкая растяжка по желанию</div></div></section>`;
  } else {
    if (!d.rest) {
      const warm = d.warm || WARMUP;
      const warmItems = d.warmNote ? [...warm.items, 'Акцент дня: ' + d.warmNote] : warm.items;
      html += `<details class="px block"><summary>${esc(warm.title)}</summary><ul>${warmItems.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>`;
    }

    d.blocks.forEach((b, bi) => {
      html += `<section class="block px">
        <div class="block-head"><h3>${esc(b.t)}</h3></div>
        ${b.note ? `<div class="block-note">${esc(b.note)}</div>` : ''}
        ${b.items.map((ex, ei) => exRow(ex, curWeek, curView, bi, ei)).join('')}
      </section>`;
    });

    if (!d.rest) {
      const cool = d.cool || COOLDOWN;
      html += `<details class="px block"><summary>${esc(cool.title)}</summary><ul>${cool.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>`;
    }
  }

  $view.innerHTML = html;

  // обработчики: описания
  $view.querySelectorAll('[data-q]').forEach(b =>
    b.addEventListener('click', () => openModal(b.dataset.q)));

  // обработчики: выполнение дня (всплывший день пишется в свою исходную неделю)
  $view.querySelectorAll('[data-done]').forEach(b =>
    b.addEventListener('click', () => setDayStatus(effWeek, progKey, b.dataset.done || null)));

  // обработчики: запись веса
  $view.querySelectorAll('[data-log]').forEach(btn =>
    btn.addEventListener('click', () => {
      const row = btn.closest('.ex');
      const w = row.querySelector('[data-weight]').value.trim().replace(',', '.');
      const note = row.querySelector('[data-note]').value.trim();
      if (!w && !note) { toast('ПУСТО — ВВЕДИ ВЕС ИЛИ ЗАМЕТКУ'); return; }
      store.entries.push({
        id: Date.now(), date: iso(new Date()), exName: btn.dataset.name,
        week: effWeek, day: curView, weight: w, note, ts: new Date().toTimeString().slice(0, 5),
      });
      saveStore();
      toast('ЗАПИСАНО ■');
      render();
    }));
}

/* ---------- редактор программы ---------- */
function renderDayEdit(P, wk, d) {
  const inp = (val, ph) => `<input class="einput" value="${esc(val || '')}" placeholder="${esc(ph || '')}">`;

  let html = `<div class="weekinfo px"><span class="theme" style="color:var(--warn)">РЕЖИМ ПРАВКИ — изменения сохраняются сразу</span></div>
  <section class="block px editblock">
    <div class="block-head"><h3>НЕДЕЛЯ</h3></div>
    <label class="elabel">название недели</label><div data-ebind="wk.theme">${inp(wk.theme, 'например: Накопление')}</div>
    <label class="elabel">нагрузка (RPE · вес)</label><div data-ebind="wk.rpe">${inp(wk.rpe, 'например: RPE 6–7 · 16 кг')}</div>
    <label class="elabel">заметка к неделе</label><div data-ebind="wk.hint">${inp(wk.hint, 'короткая подсказка')}</div>
    <div class="toolbar">
      <button class="toolbtn" id="btnAddWeek">+ НЕДЕЛЯ</button>
      <button class="toolbtn" id="btnImportProg">▲ ИМПОРТ ИЗ ФАЙЛА</button>
      <button class="toolbtn danger" id="btnDelWeek">УДАЛИТЬ НЕДЕЛЮ ${wk.n}</button>
    </div>
  </section>

  <section class="block px editblock">
    <div class="block-head"><h3>ДЕНЬ (${DAY_NAMES[curView]})</h3></div>
    <label class="elabel">название дня</label><div data-ebind="d.title">${inp(d.title, 'например: День 1 · Толчок + ноги')}</div>
    <label class="elabel">фокус</label><div data-ebind="d.focus">${inp(d.focus, 'например: Гиревая дисциплина')}</div>
    <label class="elabel">время</label><div data-ebind="d.dur">${inp(d.dur, 'например: 60 мин')}</div>
    <label class="echeck"><input type="checkbox" id="edRest" ${d.rest ? 'checked' : ''}> день отдыха</label>
  </section>`;

  (d.blocks || []).forEach((b, bi) => {
    html += `<section class="block px editblock">
      <div class="block-head"><h3>БЛОК ${bi + 1}</h3></div>
      <label class="elabel">название блока</label><div data-ebind="b${bi}.t">${inp(b.t, 'Основная часть')}</div>
      ${b.items.map((ex, ei) => `
        <div class="editrow">
          <div class="editrow-main">
            <div data-ebind="b${bi}.i${ei}.n">${inp(ex.n, 'упражнение')}</div>
            <div data-ebind="b${bi}.i${ei}.s">${inp(ex.s, 'схема: 3×10 · 16 кг')}</div>
          </div>
          <label class="echeck" title="показывать поле веса"><input type="checkbox" data-ew="${bi}.${ei}" ${ex.w ? 'checked' : ''}> вес</label>
          <button class="del" data-dex="${bi}.${ei}" aria-label="Удалить упражнение">X</button>
        </div>`).join('')}
      <div class="toolbar">
        <button class="toolbtn" data-addex="${bi}">+ УПРАЖНЕНИЕ</button>
        <button class="toolbtn danger" data-delblock="${bi}">УДАЛИТЬ БЛОК</button>
      </div>
    </section>`;
  });

  html += `<div class="toolbar"><button class="toolbtn" id="btnAddBlock">+ БЛОК</button></div>`;

  $view.innerHTML = html;

  // текстовые поля: меняют модель без перерисовки (фокус не теряется)
  $view.querySelectorAll('[data-ebind] input').forEach(el => {
    el.addEventListener('input', () => {
      const path = el.closest('[data-ebind]').dataset.ebind.split('.');
      if (path[0] === 'wk') { wk[path[1]] = el.value; }
      else if (path[0] === 'd') { d[path[1]] = el.value; }
      else { // b<bi>.t или b<bi>.i<ei>.<f>
        const b = d.blocks[+path[0].slice(1)];
        if (path.length === 2) b.t = el.value;
        else b.items[+path[1].slice(1)][path[2]] = el.value;
      }
      saveProgram();
      renderNav(); // обновить подписи недель в навигаторе
    });
  });

  document.getElementById('edRest').addEventListener('change', e => {
    d.rest = e.target.checked; saveProgram(); render();
  });

  document.getElementById('btnAddWeek').addEventListener('click', () => {
    P.push(newWeek(P.length + 1)); saveProgram(); curWeek = P.length; render();
  });
  document.getElementById('btnImportProg').addEventListener('click', () =>
    document.getElementById('progFile').click());
  document.getElementById('btnDelWeek').addEventListener('click', () => {
    P.splice(curWeek - 1, 1); renumberWeeks(P);
    curWeek = Math.max(1, Math.min(curWeek, P.length));
    if (!P.length) programOverride = P; // пустая программа — чистый лист
    saveProgram(); render();
  });
  document.getElementById('btnAddBlock').addEventListener('click', () => {
    d.blocks = d.blocks || []; d.blocks.push(newBlock()); saveProgram(); render();
  });
  $view.querySelectorAll('[data-addex]').forEach(b =>
    b.addEventListener('click', () => {
      d.blocks[+b.dataset.addex].items.push(newExercise()); saveProgram(); render();
    }));
  $view.querySelectorAll('[data-delblock]').forEach(b =>
    b.addEventListener('click', () => {
      d.blocks.splice(+b.dataset.delblock, 1); saveProgram(); render();
    }));
  $view.querySelectorAll('[data-dex]').forEach(b =>
    b.addEventListener('click', () => {
      const [bi, ei] = b.dataset.dex.split('.').map(Number);
      d.blocks[bi].items.splice(ei, 1); saveProgram(); render();
    }));
  $view.querySelectorAll('[data-ew]').forEach(c =>
    c.addEventListener('change', () => {
      const [bi, ei] = c.dataset.ew.split('.').map(Number);
      d.blocks[bi].items[ei].w = c.checked; saveProgram();
    }));
}

/* ---------- модалка с описанием ---------- */
function showModal(name, descr) {
  $modalRoot.innerHTML = `<div class="modal-back" role="dialog" aria-modal="true" aria-label="${esc(name)}">
    <div class="modal px">
      <button class="x" aria-label="Закрыть">X</button>
      <h3>${esc(name)}</h3>
      <p>${esc(descr)}</p>
    </div>
  </div>`;
  const back = $modalRoot.firstElementChild;
  back.querySelector('.x').addEventListener('click', closeModal);
  back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  back.querySelector('.x').focus();
}

function descrCache() {
  try { return JSON.parse(localStorage.getItem('sportlog.descr') || '{}'); }
  catch (e) { return {}; }
}

async function openModal(name) {
  let descr = DESCR[name] || descrCache()[name];
  if (descr) { showModal(name, descr); return; }
  if (!remote.token) { showModal(name, 'Описание пока не добавлено. Войди в аккаунт (ИНФО) — найду описание автоматически.'); return; }
  showModal(name, '…ищу описание…');
  try {
    const r = await api('/api/describe', { method: 'POST', body: JSON.stringify({ name }) });
    if (r.ok) {
      const d = await r.json();
      const cache = descrCache();
      cache[name] = d.description;
      localStorage.setItem('sportlog.descr', JSON.stringify(cache));
      if ($modalRoot.firstElementChild) showModal(name, d.description); // модалка ещё открыта
      return;
    }
  } catch (e) { /* нет сети/сервера */ }
  if ($modalRoot.firstElementChild) showModal(name, 'Описание пока не добавлено.');
}
function closeModal() {
  $modalRoot.innerHTML = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------- дневник ---------- */
function renderDiary() {
  const byDate = {};
  store.entries.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  const dates = Object.keys(byDate).sort().reverse();

  let html = `<div class="dayhead px"><h2>ДНЕВНИК ТРЕНИРОВОК</h2>
    <div class="meta"><span>записей: <b>${store.entries.length}</b></span><span>дней: <b>${dates.length}</b></span></div></div>`;

  if (!dates.length) {
    html += `<section class="block px"><div class="empty">пока пусто —<br>записывай веса на странице тренировки</div></section>`;
  } else {
    dates.forEach(dt => {
      const list = byDate[dt];
      const wd = DAY_NAMES[list[0].day] || '';
      html += `<section class="block px diary-day">
        <div class="dhead"><h3>${dt.slice(8)}.${dt.slice(5, 7)}.${dt.slice(0, 4)}</h3><span>${wd} · неделя ${list[0].week}</span></div>
        ${list.map(e => `<div class="dentry">
          <span class="n">${esc(e.exName)}</span>
          <span class="w">${e.weight ? esc(e.weight) + ' кг' : ''}</span>
          <span class="c">${esc(e.note || '')}</span>
          <button class="del" data-del="${e.id}" aria-label="Удалить запись">X</button>
        </div>`).join('')}
      </section>`;
    });
  }

  html += `<div class="toolbar">
    <button class="toolbtn" id="btnExport">▼ ЭКСПОРТ JSON</button>
    <button class="toolbtn" id="btnImport">▲ ИМПОРТ JSON</button>
  </div>`;

  $view.innerHTML = html;

  $view.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => {
      store.entries = store.entries.filter(e => e.id !== +b.dataset.del);
      saveStore(); render();
    }));
  document.getElementById('btnExport').addEventListener('click', exportJSON);
  document.getElementById('btnImport').addEventListener('click', () =>
    document.getElementById('importFile').click());
}

/* ---------- статистика ---------- */
let statsEx = null;

function exStats() {
  const byEx = {};
  store.entries.forEach(e => {
    const w = parseFloat(String(e.weight || '').replace(',', '.'));
    if (!isFinite(w)) return;
    (byEx[e.exName] = byEx[e.exName] || []).push({ ...e, wNum: w });
  });
  Object.values(byEx).forEach(l =>
    l.sort((a, b) => (a.date + (a.ts || '')).localeCompare(b.date + (b.ts || ''))));
  return byEx;
}

function renderStats() {
  const byEx = exStats();
  const names = Object.keys(byEx).sort((a, b) => byEx[b].length - byEx[a].length);

  if (!names.length) {
    $view.innerHTML = `<div class="dayhead px"><h2>СТАТИСТИКА</h2></div>
      <section class="block px"><div class="empty">пока нет записей с весом —<br>записывай веса на странице тренировки</div></section>`;
    return;
  }

  if (!statsEx || !byEx[statsEx]) statsEx = names[0];
  const list = byEx[statsEx];
  const ws = list.map(e => e.wNum);
  const min = Math.min(...ws), max = Math.max(...ws);
  const lastW = ws[ws.length - 1];
  const delta = Math.round((lastW - ws[0]) * 10) / 10;
  const shown = list.slice(-12);

  const bars = shown.map((e, i) => {
    const h = 15 + 85 * (max > min ? (e.wNum - min) / (max - min) : 1);
    const cls = (e.wNum === max ? ' max' : '') + (i === shown.length - 1 ? ' last' : '');
    return `<div class="stcol" title="${e.date} — ${e.wNum} кг${e.note ? ' · ' + esc(e.note) : ''}">
      <span class="stval">${e.wNum}</span>
      <div class="stbar${cls}" style="height:${h}%"></div>
      <span class="stdate">${e.date.slice(8)}.${e.date.slice(5, 7)}</span>
    </div>`;
  }).join('');

  $view.innerHTML = `<div class="dayhead px"><h2>СТАТИСТИКА</h2>
    <div class="meta"><span>упражнений с записями: <b>${names.length}</b></span></div></div>
  <section class="block px" style="padding:10px 12px">
    <div class="expick">${names.map(n =>
      `<button class="exbtn ${n === statsEx ? 'active' : ''}" data-ex="${esc(n)}">${esc(n)}</button>`).join('')}</div>
  </section>
  <div class="dayhead px"><h2>${esc(statsEx)}</h2>
    <div class="meta"><span>записей: <b>${list.length}</b></span><span>рекорд: <b>${max} кг</b></span><span>последний: <b>${lastW} кг</b></span><span>Δ <b class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${delta > 0 ? '+' : ''}${delta} кг</b></span></div></div>
  <section class="block px" style="padding:14px 10px 10px">
    <div class="statchart">${bars}</div>
    ${list.length > 12 ? `<div class="stnote">последние 12 записей из ${list.length}</div>` : ''}
  </section>
  <section class="block px" style="padding:8px 14px 12px">
    ${list.slice(-5).reverse().map(e => `<div class="dentry">
      <span class="n">${e.date.slice(8)}.${e.date.slice(5, 7)}.${e.date.slice(0, 4)}</span>
      <span class="w">${e.wNum} кг</span>
      <span class="c">${esc(e.note || '')}</span>
    </div>`).join('')}
  </section>`;

  $view.querySelectorAll('[data-ex]').forEach(b =>
    b.addEventListener('click', () => { statsEx = b.dataset.ex; render(); }));
}

function exportJSON() {  const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sport-dnevnik-${iso(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('ЭКСПОРТИРОВАНО ▼');
}

document.getElementById('importFile').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!Array.isArray(data.entries)) throw new Error('bad');
      store = { entries: data.entries, meas: data.meas || {}, done: data.done || {}, startDate: data.startDate || null };
      saveStore(); toast('ИМПОРТИРОВАНО ▲'); render();
    } catch (err) { toast('ОШИБКА ФАЙЛА'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/* ---------- вкладка импорта программы ---------- */
function renderImport() {
  const P = PROG() || [];
  $view.innerHTML = `<div class="dayhead px"><h2>ИМПОРТ ПРОГРАММЫ</h2>
    <div class="meta"><span>месяц целиком, одним файлом</span></div></div>
  <section class="block px" style="padding:14px">
    <p style="font-size:20px">Скинь файл с программой — <b style="color:var(--warn);font-weight:400">.txt · .md · .docx</b></p>
    <p style="font-size:18px;color:var(--text-dim);margin-top:8px">Groq сам разложит её по неделям и дням: названия, схемы, веса. Перед применением покажу, что распозналось. Разбор занимает 5–20 секунд.</p>
    <p style="font-size:18px;color:var(--text-dim);margin-top:8px">Сейчас в программе: <b style="color:var(--text-bright);font-weight:400">${P.length ? P.length + ' нед.' : 'пусто'}</b></p>
    <div class="toolbar" style="margin-top:12px">
      <button class="toolbtn" id="btnImportProg">▲ ВЫБРАТЬ ФАЙЛ</button>
    </div>
  </section>
  <section class="block px" style="padding:12px 14px">
    <p style="font-size:18px;color:var(--text-dim)">Совет: чем чётче структура в файле (неделя → день → упражнения с подходами и весами), тем точнее разбор. После импорта всё можно поправить руками в режиме ✎.</p>
  </section>`;
  document.getElementById('btnImportProg').addEventListener('click', () =>
    document.getElementById('progFile').click());
}

/* ---------- импорт программы из файла ---------- */
function showProgModal(html) {
  $modalRoot.innerHTML = `<div class="modal-back" role="dialog" aria-modal="true">
    <div class="modal px">${html}</div></div>`;
  const back = $modalRoot.firstElementChild;
  back.addEventListener('click', e => { if (e.target === back) closeModal(); });
  return back;
}

async function importProgramFile(f) {
  showProgModal(`<h3>ИМПОРТ ПРОГРАММЫ</h3><p>…разбираю файл через Groq, это может занять до минуты…</p>`);
  let d = null;
  try {
    const ext = (f.name.split('.').pop() || 'txt').toLowerCase();
    const r = await api('/api/import-program', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 'program.' + ext },
      body: f,
    });
    d = await r.json().catch(() => ({}));
    if (!r.ok) d = { error: d.error || 'server' };
  } catch (e) { d = { error: 'server' }; }
  if (d.error) {
    const msgs = {
      no_groq_key: 'на сервере нет ключа Groq', bad_file: 'не смог прочитать файл',
      empty: 'файл пустой', parse_failed: 'не удалось распознать программу — попробуй другой файл',
      server: 'сервер недоступен',
    };
    const back = showProgModal(`<h3>ИМПОРТ ПРОГРАММЫ</h3><p>${msgs[d.error] || d.error}</p>
      <div class="toolbar"><button class="toolbtn" data-x>ЗАКРЫТЬ</button></div>`);
    back.querySelector('[data-x]').addEventListener('click', closeModal);
    return;
  }
  const weeks = d.program;
  const list = weeks.map(w => `неделя ${w.n}: ${esc(w.theme)}`).join('<br>');
  const skipped = d.skipped ? `<p style="color:var(--danger);font-size:18px">не разобралось кусков: ${d.skipped} — проверь программу и добей руками в режиме ✎</p>` : '';
  const back = showProgModal(`<h3>ИМПОРТ ПРОГРАММЫ</h3>
    <p>распознано недель: <b>${weeks.length}</b></p>
    <p style="color:var(--text-dim);font-size:18px">${list}</p>
    ${skipped}
    <p style="color:var(--warn);font-size:18px">заменит текущую программу · старт цикла — сегодня, отметки выполнения сбросятся</p>
    <div class="toolbar"><button class="toolbtn" data-ok>ПРИМЕНИТЬ</button><button class="toolbtn" data-x>ОТМЕНА</button></div>`);
  back.querySelector('[data-x]').addEventListener('click', closeModal);
  back.querySelector('[data-ok]').addEventListener('click', () => {
    programOverride = weeks;
    store.done = {}; store.startDate = iso(new Date()); saveStore();
    curWeek = 1; curView = TODAY.day; saveProgram(); closeModal(); render();
    toast('ПРОГРАММА ИМПОРТИРОВАНА ▲');
  });
}

document.getElementById('progFile').addEventListener('change', e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) importProgramFile(f);
});

/* ---------- инфо ---------- */
function renderInfo() {
  let html = `<div class="dayhead px"><h2>АККАУНТ</h2></div>
  <section class="block px" style="padding:12px 14px">
    ${remote.token
      ? `<div style="font-size:20px">вход выполнен: <b style="color:var(--accent);font-weight:400">${esc(remote.login || '')}</b> · синхронизация: <b style="color:${remote.online ? 'var(--accent)' : 'var(--warn)'};font-weight:400">${remote.online ? 'онлайн' : 'офлайн — записи локально'}</b></div>
         <div style="font-size:18px;color:var(--text-dim);margin:10px 0 4px">сменить пароль (минимум 6 символов):</div>
         <div class="logrow"><input id="passOld" type="password" placeholder="текущий" autocomplete="current-password" style="width:100px"><input id="passNew" type="password" placeholder="новый" autocomplete="new-password" style="width:100px"><input id="passNew2" type="password" placeholder="ещё раз" autocomplete="new-password" style="width:100px"><button class="logbtn" id="btnPass">СМЕНИТЬ</button></div>
         <div id="passErr" style="color:var(--danger);font-size:18px;margin-top:6px"></div>
         <div class="toolbar"><button class="toolbtn" id="btnLogout">ВЫЙТИ</button></div>`
      : `<div style="font-size:20px;color:var(--text-dim);margin-bottom:8px">вход не выполнен — данные только на этом устройстве</div>
         <div class="logrow"><input id="loginName" placeholder="логин" autocomplete="username" style="width:130px"><input id="loginPass" type="password" placeholder="пароль" autocomplete="current-password" style="width:130px"><button class="logbtn" id="btnLogin">ВОЙТИ</button></div>
         <div id="loginErr" style="color:var(--danger);font-size:18px;margin-top:6px"></div>`}
  </section>

  <div class="dayhead px"><h2>СТАРТ ЦИКЛА</h2></div>
  <section class="block px" style="padding:12px 14px">
    <div style="font-size:20px">день 1 программы: <b style="color:var(--accent);font-weight:400">${anchorIso().split('-').reverse().join('.')}</b>${store.startDate ? '' : ' <span style="color:var(--text-dim);font-size:16px">(по умолчанию)</span>'}</div>
    <div style="font-size:18px;color:var(--text-dim);margin:6px 0">по умолчанию день 1 — понедельник; сдвинь, если начинаешь в другой день — вся сетка переедет. отметки выполнения сбросятся</div>
    <div class="toolbar"><button class="toolbtn" id="btnStartToday">▶ НАЧАТЬ С СЕГОДНЯ</button>${store.startDate ? '<button class="toolbtn danger" id="btnStartReset">СБРОС</button>' : ''}</div>
    <div class="logrow" style="margin-top:10px">
      <input type="date" id="startDatePick" value="${anchorIso()}" style="width:150px">
      <button class="logbtn" id="btnStartDate">НАЧАТЬ С ДАТЫ</button>
    </div>
  </section>

  <div class="dayhead px"><h2>ОФОРМЛЕНИЕ</h2></div>
  <section class="block px" style="padding:12px 14px">
    <div class="themepick">
      ${Object.entries(THEMES).map(([k, t]) =>
        `<button class="themesw ${k === curTheme ? 'active' : ''}" data-theme-pick="${k}" style="background:${t.sw}" title="${t.name}" aria-label="Тема: ${t.name}"></button>`).join('')}
    </div>
    <div class="fontpick">
      <button class="exbtn ${curFont === 'px' ? 'active' : ''}" data-font-pick="px">ПИКСЕЛЬ</button>
      <button class="exbtn ${curFont === 'mono' ? 'active' : ''}" data-font-pick="mono" style="font-family:'JetBrains Mono',monospace">МОНО</button>
    </div>
  </section>

  <div class="dayhead px"><h2>ПРАВИЛА МЕСЯЦА</h2></div>
  <section class="block px"><ul style="padding:12px 18px 12px 30px">
    ${RULES.map(r => `<li style="padding:4px 0;font-size:20px;list-style:square">${esc(r)}</li>`).join('')}
  </ul></section>

  <div class="dayhead px"><h2>ЗАМЕРЫ «ДО»</h2>
    <div class="meta"><span>отметь выполненное</span></div></div>
  <section class="block px"><ul class="meas" style="padding:12px 18px 12px 20px;list-style:none">
    ${MEASUREMENTS.map((m, i) => `<li class="${store.meas[i] ? 'done' : ''}" style="padding:5px 0;font-size:20px">
      <input type="checkbox" id="meas${i}" data-meas="${i}" ${store.meas[i] ? 'checked' : ''}>
      <label for="meas${i}"><span>${esc(m)}</span></label></li>`).join('')}
  </ul></section>

  <div class="dayhead px"><h2>ОБОЗНАЧЕНИЯ</h2></div>
  <section class="block px"><ul style="padding:12px 18px 12px 30px">
    ${GLOSSARY.map(([t, d]) => `<li style="padding:4px 0;font-size:20px;list-style:square"><b style="color:var(--warn);font-weight:400">${esc(t)}</b> — ${esc(d)}</li>`).join('')}
  </ul></section>`;

  $view.innerHTML = html;

  const btnLogin = document.getElementById('btnLogin');
  if (btnLogin) btnLogin.addEventListener('click', async () => {
    const l = document.getElementById('loginName').value.trim();
    const p = document.getElementById('loginPass').value;
    const err = document.getElementById('loginErr');
    if (!l || !p) { err.textContent = 'введи логин и пароль'; return; }
    err.textContent = '…';
    try { await doLogin(l, p); toast('СИНХРОНИЗАЦИЯ ВКЛЮЧЕНА ■'); }
    catch (e) { err.textContent = e.message || 'нет связи с сервером'; }
  });
  const btnLogout = document.getElementById('btnLogout');
  if (btnLogout) btnLogout.addEventListener('click', () => { doLogout(); toast('ВЫШЕЛ ИЗ АККАУНТА'); });

  const btnPass = document.getElementById('btnPass');
  if (btnPass) btnPass.addEventListener('click', async () => {
    const o = document.getElementById('passOld').value;
    const n1 = document.getElementById('passNew').value;
    const n2 = document.getElementById('passNew2').value;
    const err = document.getElementById('passErr');
    err.style.color = 'var(--danger)';
    if (!o || !n1) { err.textContent = 'заполни все поля'; return; }
    if (n1.length < 6) { err.textContent = 'новый пароль — минимум 6 символов'; return; }
    if (n1 !== n2) { err.textContent = 'новые пароли не совпадают'; return; }
    err.textContent = '…';
    try {
      const r = await api('/api/password', { method: 'POST', body: JSON.stringify({ old_password: o, new_password: n1 }) });
      if (r.status === 403) { err.textContent = 'текущий пароль неверный'; return; }
      if (!r.ok) { err.textContent = 'не получилось — попробуй ещё раз'; return; }
      const d = await r.json();
      remote.token = d.token;
      localStorage.setItem('sportlog.token', d.token);
      err.style.color = 'var(--accent)';
      err.textContent = '■ ПАРОЛЬ ОБНОВЛЁН — остальные устройства выкинуло';
      ['passOld', 'passNew', 'passNew2'].forEach(id => { document.getElementById(id).value = ''; });
    } catch (e) { err.textContent = 'нет связи с сервером'; }
  });

  const btnStartToday = document.getElementById('btnStartToday');
  if (btnStartToday) btnStartToday.addEventListener('click', () => {
    store.startDate = iso(new Date());
    store.done = {}; // новый старт — чистый прогресс
    saveStore(); render();
    toast('ДЕНЬ 1 — СЕГОДНЯ ▶');
  });
  const btnStartReset = document.getElementById('btnStartReset');
  if (btnStartReset) btnStartReset.addEventListener('click', () => {
    store.startDate = null; saveStore(); render();
  });
  const btnStartDate = document.getElementById('btnStartDate');
  if (btnStartDate) btnStartDate.addEventListener('click', () => {
    const v = document.getElementById('startDatePick').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { toast('ВЫБЕРИ ДАТУ'); return; }
    store.startDate = v;
    store.done = {}; // новый старт — чистый прогресс
    saveStore(); render();
    toast('ДЕНЬ 1 — ' + v.slice(8) + '.' + v.slice(5, 7) + ' ▶');
  });

  $view.querySelectorAll('[data-theme-pick]').forEach(b =>
    b.addEventListener('click', () => {
      curTheme = b.dataset.themePick;
      localStorage.setItem('sportlog.theme', curTheme);
      applyTheme(); render();
    }));
  $view.querySelectorAll('[data-font-pick]').forEach(b =>
    b.addEventListener('click', () => {
      curFont = b.dataset.fontPick;
      localStorage.setItem('sportlog.font', curFont);
      applyTheme(); render();
    }));

  $view.querySelectorAll('[data-meas]').forEach(c =>
    c.addEventListener('change', () => {
      store.meas[c.dataset.meas] = c.checked;
      saveStore();
      c.closest('li').classList.toggle('done', c.checked);
    }));
}

/* ---------- главный рендер ---------- */
function render() {
  if (!remote.token) { renderGate(); return; } // без входа — только экран логина
  document.querySelector('.top').style.display = '';
  renderDate();
  renderNav();
  if (curView === 'diary') renderDiary();
  else if (curView === 'stats') renderStats();
  else if (curView === 'info') renderInfo();
  else if (curView === 'import') renderImport();
  else renderDay();
  window.scrollTo({ top: 0 });
}

/* ---------- экран входа ---------- */
function renderGate() {
  document.querySelector('.top').style.display = 'none'; // шапку на воротах прячем
  $weekNav.innerHTML = '';
  $dayNav.innerHTML = '';
  $view.innerHTML = `<section class="block px gate">
    <div class="gate-logo">СПОРТ<br>ДНЕВНИК</div>
    <div class="gate-sub">введи логин и пароль</div>
    <div class="logrow gate-row">
      <input id="loginName" placeholder="логин" autocomplete="username" style="width:130px">
      <input id="loginPass" type="password" placeholder="пароль" autocomplete="current-password" style="width:130px">
      <button class="logbtn" id="btnLogin">ВОЙТИ</button>
    </div>
    <div id="loginErr" style="color:var(--danger);font-size:18px;margin-top:6px"></div>
  </section>`;
  window.scrollTo({ top: 0 });

  const err = document.getElementById('loginErr');
  const submit = async () => {
    const l = document.getElementById('loginName').value.trim();
    const p = document.getElementById('loginPass').value;
    if (!l || !p) { err.textContent = 'введи логин и пароль'; return; }
    err.textContent = '…';
    try { await doLogin(l, p); }
    catch (e) { err.textContent = e.message || 'нет связи с сервером'; }
  };
  document.getElementById('btnLogin').addEventListener('click', submit);
  $view.querySelectorAll('#loginName, #loginPass').forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
  document.getElementById('loginName').focus();
}

(async () => {
  await syncInit();
  if (remote.token) { curWeek = TODAY.week; curView = TODAY.day; } // открываемся на сегодняшний день
  render();
})();
