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
function saveStore() { localStorage.setItem(LS_KEY, JSON.stringify(store)); }
let store = loadStore();

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
  $weekNav.innerHTML = WEEKS.map(w =>
    `<button class="navbtn ${w.n === curWeek ? 'active' : ''} ${w.n === TODAY.week && TODAY.inPlan ? 'today-mark' : ''}" data-week="${w.n}">
      НЕД ${w.n}<small>${esc(w.theme)}</small>
    </button>`).join('');
  $weekNav.querySelectorAll('button').forEach(b =>
    b.addEventListener('click', () => { curWeek = +b.dataset.week; if (curView === 'diary' || curView === 'info') curView = TODAY.day; render(); }));

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
  const wk = WEEKS[curWeek - 1];
  const d = wk.days[REAL_TO_PROG[curView] || curView];
  const isToday = TODAY.inPlan && curWeek === TODAY.week && curView === TODAY.day;

  let html = `<div class="weekinfo px">
    <span class="theme">Неделя ${wk.n} — ${esc(wk.theme)}</span>
    <span class="rpe">${esc(wk.rpe)}</span>
    <span class="hint">${esc(wk.hint)}</span>
  </div>
  <div class="dayhead px">
    <h2>${esc(d.title)}${isToday ? '<span class="today-badge">СЕГОДНЯ</span>' : ''}</h2>
    <div class="meta"><span><b>${DAY_NAMES[curView]}</b> · день ${TAB_ORDER.indexOf(curView) + 1} программы</span><span>фокус: <b>${esc(d.focus)}</b></span><span>время: <b>${esc(d.dur)}</b></span></div>
  </div>`;

  if (d.rest) {
    html += `<section class="block px"><div class="restbox"><div class="big">ОТДЫХ<br><br>сон · еда · прогулка<br>мягкая растяжка по желанию</div></div></section>`;
  } else {
    const isKbDay = /гирев|рывок|толчок|комплекс/i.test(d.title);
    const warm = isKbDay ? WARMUP : {
      title: 'Разминка (8–10 мин)',
      items: [
        'Суставная гимнастика: шея → плечи → таз → колени → голеностоп — по 30 сек',
        '3–5 мин лёгкого кардио (гребля/аэробайк), пульс ~120',
        '2–3 движения из основной части в лёгком варианте',
      ],
    };
    html += `<details class="px block"><summary>${esc(warm.title)}</summary><ul>${warm.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>`;

    d.blocks.forEach((b, bi) => {
      html += `<section class="block px">
        <div class="block-head"><h3>${esc(b.t)}</h3></div>
        ${b.note ? `<div class="block-note">${esc(b.note)}</div>` : ''}
        ${b.items.map((ex, ei) => exRow(ex, curWeek, curView, bi, ei)).join('')}
      </section>`;
    });

    html += `<details class="px block"><summary>${esc(COOLDOWN.title)}</summary><ul>${COOLDOWN.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></details>`;
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

/* ---------- модалка с описанием ---------- */
function openModal(name) {
  const descr = DESCR[name] || 'Описание пока не добавлено.';
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

function timerBeep() {
  try {
    timer.audio = timer.audio || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = timer.audio, t0 = ctx.currentTime;
    [0, 0.25, 0.5].forEach(d => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.setValueAtTime(0.07, t0 + d);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.18);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + d); o.stop(t0 + d + 0.2);
    });
  } catch (e) { /* без звука */ }
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
  let html = `<div class="dayhead px"><h2>ПРАВИЛА МЕСЯЦА</h2></div>
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

render();
