import {
  START_DATE, DAY_NAMES, DAY_ORDER, TAB_ORDER, REAL_TO_PROG, DESCR,
  WARMUP, COOLDOWN, RULES, MEASUREMENTS, WEEKS, GLOSSARY,
} from './data.js';

const LS_KEY = 'sportlog.v1';

/* ---------- хранилище ---------- */
function loadStore() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* повреждённые данные — начинаем с чистого */ }
  return { entries: [], meas: {} };
}
function saveLocal() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
function saveStore() {
  saveLocal();
  queuePush();
}
let store = loadStore();

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
    if (state.diary && Array.isArray(state.diary.entries) && state.diary.entries.length) {
      store = state.diary; // сервер новее локального — сервер главный
      saveLocal();
    } else if (store.entries.length) {
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
function todayInfo() {
  const start = new Date(START_DATE + 'T00:00:00');
  const now = new Date();
  const diff = Math.floor((new Date(iso(now) + 'T00:00:00') - start) / DAY_MS);
  if (diff >= 0 && diff < 28) {
    return { week: Math.floor(diff / 7) + 1, day: TAB_ORDER[diff % 7], inPlan: true };
  }
  return { week: 1, day: DAY_ORDER[(now.getDay() + 6) % 7], inPlan: false };
}
const TODAY = todayInfo();

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
(function renderDate() {
  const now = new Date();
  const wd = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'][now.getDay()];
  document.getElementById('dateNow').innerHTML =
    `<b>${wd}</b> ${iso(now).split('-').reverse().join('.')}` +
    (TODAY.inPlan ? `<br>неделя <b>${TODAY.week}</b> из 4` : `<br>вне плана`);
})();

/* ---------- навигация ---------- */
function renderNav() {
  const P = PROG() || [];
  $weekNav.innerHTML = P.map(w =>
    `<button class="navbtn ${w.n === curWeek ? 'active' : ''} ${w.n === TODAY.week && TODAY.inPlan ? 'today-mark' : ''}" data-week="${w.n}">
      НЕД ${w.n}<small>${esc(w.theme)}</small>
    </button>`).join('') +
    `<button class="navbtn editbtn ${editMode ? 'active' : ''}" data-edit="1" title="Режим правки программы">✎</button>`;
  $weekNav.querySelectorAll('[data-week]').forEach(b =>
    b.addEventListener('click', () => { curWeek = +b.dataset.week; if (curView === 'diary' || curView === 'info') curView = TODAY.day; render(); }));
  $weekNav.querySelector('[data-edit]').addEventListener('click', () => { editMode = !editMode; render(); });

  const dayBtns = TAB_ORDER.map(d =>
    `<button class="navbtn ${d === curView ? 'active' : ''} ${d === TODAY.day && TODAY.inPlan ? 'today-mark' : ''}" data-day="${d}">${DAY_NAMES[d]}</button>`).join('');
  $dayNav.innerHTML = dayBtns +
    `<button class="navbtn ${curView === 'diary' ? 'active' : ''}" data-day="diary">ДНЕВ<br>НИК</button>` +
    `<button class="navbtn ${curView === 'info' ? 'active' : ''}" data-day="info">ИНФО</button>`;
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

/* ---------- рендер дня ---------- */
function exRow(ex, wn, d, bi, ei) {
  const id = `w${wn}-${d}-${bi}-${ei}`;
  const hasDescr = !!DESCR[ex.n];
  const last = lastLog(ex.n);
  const timerSvg = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 2a5 5 0 1 1 0 10A5 5 0 0 1 8 3zM7 5h2v3h3v2H7z"/></svg>';
  return `<div class="ex" data-exid="${id}">
    <div class="ex-row">
      <span class="ex-name">${esc(ex.n)}</span>
      <span class="ex-scheme">${esc(ex.s)}</span>
      ${hasDescr ? `<button class="qbtn" data-q="${esc(ex.n)}" title="Описание упражнения" aria-label="Описание: ${esc(ex.n)}">?</button>` : ''}
      <button class="qbtn timerbtn" data-timer="${esc(ex.n)}" title="Таймер" aria-label="Таймер: ${esc(ex.n)}">${timerSvg}</button>
    </div>
    ${ex.w ? `<div class="logrow">
      <label for="w-${id}">вес, кг</label>
      <input id="w-${id}" inputmode="decimal" placeholder="—" data-weight>
      <input class="note" placeholder="заметка (повторы, самочувствие)" data-note>
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
      ПРОГРАММА ПУСТАЯ<br><br>собери свою — или загрузи базовую</div></section>
      <div class="toolbar">
        <button class="toolbtn" id="btnNewWeek">+ СОЗДАТЬ НЕДЕЛЮ 1</button>
        <button class="toolbtn" id="btnLoadBase">▼ ЗАГРУЗИТЬ БАЗОВУЮ</button>
      </div>`;
    document.getElementById('btnNewWeek').addEventListener('click', () => {
      programOverride = [newWeek(1)];
      curWeek = 1; saveProgram(); render();
    });
    document.getElementById('btnLoadBase').addEventListener('click', () => {
      programOverride = JSON.parse(JSON.stringify(WEEKS));
      saveProgram(); render();
    });
    return;
  }

  const d = wk.days[REAL_TO_PROG[curView] || curView] || wk.days.rest;
  const isToday = TODAY.inPlan && curWeek === TODAY.week && curView === TODAY.day;

  if (editMode) { renderDayEdit(P, wk, d); return; }

  let html = `<div class="weekinfo px">
    <span class="theme">Неделя ${wk.n} — ${esc(wk.theme)}</span>
    <span class="rpe">${esc(wk.rpe)}</span>
    <span class="hint">${esc(wk.hint)}</span>
  </div>
  <div class="dayhead px">
    <h2>${esc(d.title)}${isToday ? '<span class="today-badge">СЕГОДНЯ</span>' : ''}</h2>
    <div class="meta"><span><b>${DAY_NAMES[curView]}</b> · день ${TAB_ORDER.indexOf(curView) + 1} программы</span><span>фокус: <b>${esc(d.focus)}</b></span><span>время: <b>${esc(d.dur)}</b></span></div>
  </div>`;

  if (d.rest && !d.blocks.length) {
    html += `<section class="block px"><div class="restbox"><div class="big">ОТДЫХ<br><br>сон · еда · прогулка<br>мягкая растяжка по желанию</div></div></section>`;
  } else {
    if (!d.rest) {
      const warmItems = d.warmNote ? [...WARMUP.items, 'Акцент дня: ' + d.warmNote] : WARMUP.items;
      html += `<details class="px block"><summary>${esc(WARMUP.title)}</summary><ul>${warmItems.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>`;
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

  // обработчики: таймер
  $view.querySelectorAll('[data-timer]').forEach(b =>
    b.addEventListener('click', () => openTimer(b.dataset.timer)));

  // обработчики: запись веса
  $view.querySelectorAll('[data-log]').forEach(btn =>
    btn.addEventListener('click', () => {
      const row = btn.closest('.ex');
      const w = row.querySelector('[data-weight]').value.trim().replace(',', '.');
      const note = row.querySelector('[data-note]').value.trim();
      if (!w && !note) { toast('ПУСТО — ВВЕДИ ВЕС ИЛИ ЗАМЕТКУ'); return; }
      store.entries.push({
        id: Date.now(), date: iso(new Date()), exName: btn.dataset.name,
        week: curWeek, day: curView, weight: w, note, ts: new Date().toTimeString().slice(0, 5),
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
  stopTimer();
  $modalRoot.innerHTML = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

/* ---------- таймер ---------- */
const TIMER_PRESETS = [30, 60, 90, 120, 150, 180, 240, 300];
const timer = { total: 120, left: 120, running: false, int: null, endAt: 0, audio: null };

function fmt(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function stopTimer() {
  if (timer.int) { clearInterval(timer.int); timer.int = null; }
  timer.running = false;
}

function ensureAudio() {
  try {
    if (!timer.audio) timer.audio = new (window.AudioContext || window.webkitAudioContext)();
    if (timer.audio.state === 'suspended') timer.audio.resume();
    return timer.audio;
  } catch (e) { return null; }
}

function blip(freq, delay, dur, ctx, t0) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.07, t0 + delay);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t0 + delay); o.stop(t0 + delay + dur + 0.02);
}

function timerBeep() {
  const ctx = ensureAudio();
  if (ctx) {
    const t0 = ctx.currentTime;
    blip(880, 0, 0.18, ctx, t0);
    blip(880, 0.25, 0.18, ctx, t0);
    blip(1320, 0.5, 0.35, ctx, t0);
  }
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
}

function openTimer(name) {
  stopTimer();
  timer.left = timer.total;
  $modalRoot.innerHTML = `<div class="modal-back" role="dialog" aria-modal="true" aria-label="Таймер">
    <div class="modal px timer-modal">
      <button class="x" aria-label="Закрыть">X</button>
      <div class="timer-name">${esc(name)}</div>
      <div class="timer-display" id="tDisplay">${fmt(timer.left)}</div>
      <div class="timer-presets">
        ${TIMER_PRESETS.map(s => `<button class="tbtn ${s === timer.total ? 'sel' : ''}" data-preset="${s}">${fmt(s)}</button>`).join('')}
      </div>
      <div class="timer-controls">
        <button class="tbtn go" id="tStart">СТАРТ</button>
        <button class="tbtn" id="tReset">СБРОС</button>
      </div>
    </div>
  </div>`;
  const back = $modalRoot.firstElementChild;
  back.querySelector('.x').addEventListener('click', closeModal);
  back.addEventListener('click', e => { if (e.target === back) closeModal(); });

  const display = back.querySelector('#tDisplay');
  const startBtn = back.querySelector('#tStart');

  back.querySelectorAll('[data-preset]').forEach(b =>
    b.addEventListener('click', () => {
      stopTimer();
      timer.total = timer.left = +b.dataset.preset;
      back.querySelectorAll('[data-preset]').forEach(x => x.classList.toggle('sel', x === b));
      display.textContent = fmt(timer.left);
      display.classList.remove('done');
      startBtn.textContent = 'СТАРТ';
    }));

  startBtn.addEventListener('click', () => {
    if (timer.running) {
      stopTimer();
      startBtn.textContent = 'СТАРТ';
      return;
    }
    if (timer.left <= 0) timer.left = timer.total;
    display.classList.remove('done');
    // iOS: аудио-контекст активируем жестом пользователя + короткий сигнал-подтверждение
    const ctx = ensureAudio();
    if (ctx) blip(660, 0, 0.1, ctx, ctx.currentTime);
    timer.running = true;
    timer.endAt = Date.now() + timer.left * 1000;
    startBtn.textContent = 'ПАУЗА';
    timer.int = setInterval(() => {
      timer.left = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
      display.textContent = fmt(timer.left);
      if (timer.left <= 0) {
        stopTimer();
        display.classList.add('done');
        startBtn.textContent = 'СТАРТ';
        timerBeep();
      }
    }, 250);
  });

  back.querySelector('#tReset').addEventListener('click', () => {
    stopTimer();
    timer.left = timer.total;
    display.textContent = fmt(timer.left);
    display.classList.remove('done');
    startBtn.textContent = 'СТАРТ';
  });

  back.querySelector('.x').focus();
}

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

function exportJSON() {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
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
      store = { entries: data.entries, meas: data.meas || {} };
      saveStore(); toast('ИМПОРТИРОВАНО ▲'); render();
    } catch (err) { toast('ОШИБКА ФАЙЛА'); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/* ---------- инфо ---------- */
function renderInfo() {
  let html = `<div class="dayhead px"><h2>АККАУНТ</h2></div>
  <section class="block px" style="padding:12px 14px">
    ${remote.token
      ? `<div style="font-size:20px">вход выполнен: <b style="color:var(--accent);font-weight:400">${esc(remote.login || '')}</b> · синхронизация: <b style="color:${remote.online ? 'var(--accent)' : 'var(--warn)'};font-weight:400">${remote.online ? 'онлайн' : 'офлайн — записи локально'}</b></div>
         <div class="toolbar"><button class="toolbtn" id="btnLogout">ВЫЙТИ</button></div>`
      : `<div style="font-size:20px;color:var(--text-dim);margin-bottom:8px">вход не выполнен — данные только на этом устройстве</div>
         <div class="logrow"><input id="loginName" placeholder="логин" autocomplete="username" style="width:130px"><input id="loginPass" type="password" placeholder="пароль" autocomplete="current-password" style="width:130px"><button class="logbtn" id="btnLogin">ВОЙТИ</button></div>
         <div id="loginErr" style="color:#d87d7d;font-size:18px;margin-top:6px"></div>`}
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

  $view.querySelectorAll('[data-meas]').forEach(c =>
    c.addEventListener('change', () => {
      store.meas[c.dataset.meas] = c.checked;
      saveStore();
      c.closest('li').classList.toggle('done', c.checked);
    }));
}

/* ---------- главный рендер ---------- */
function render() {
  renderNav();
  if (curView === 'diary') renderDiary();
  else if (curView === 'info') renderInfo();
  else renderDay();
  window.scrollTo({ top: 0 });
}

(async () => {
  await syncInit();
  render();
})();
