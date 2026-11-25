# СПОРТ.ДНЕВНИК — серверная часть
# FastAPI + SQLite: аккаунты, хранилище программы/дневника, прокси к Groq
import json
import os
import re
import secrets
import sqlite3
import asyncio
import time
from contextlib import closing

import bcrypt
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get('SPORT_DB', os.path.join(BASE_DIR, 'data.db'))
WEB_DIR = os.environ.get('SPORT_WEB', os.path.join(BASE_DIR, 'web'))
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')
GROQ_MODEL = os.environ.get('GROQ_MODEL', 'openai/gpt-oss-120b')
TOKEN_TTL = 30 * 24 * 3600  # 30 дней

app = FastAPI(title='sport-dnevnik')

# ---------- БД ----------

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with closing(db()) as c:
        c.executescript('''
        CREATE TABLE IF NOT EXISTS users(
            login TEXT PRIMARY KEY,
            passhash BLOB NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens(
            token TEXT PRIMARY KEY,
            login TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv(
            login TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(login, key)
        );
        CREATE TABLE IF NOT EXISTS descr_cache(
            name TEXT PRIMARY KEY,
            description TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        ''')
        c.commit()

init_db()

# ---------- пользователи ----------

def create_user(login: str, password: str) -> bool:
    with closing(db()) as c:
        if c.execute('SELECT 1 FROM users WHERE login=?', (login,)).fetchone():
            return False
        c.execute('INSERT INTO users VALUES(?,?,?)',
                  (login, bcrypt.hashpw(password.encode(), bcrypt.gensalt()), int(time.time())))
        c.commit()
        return True

def check_user(login: str, password: str) -> bool:
    with closing(db()) as c:
        row = c.execute('SELECT passhash FROM users WHERE login=?', (login,)).fetchone()
    return bool(row) and bcrypt.checkpw(password.encode(), row['passhash'])

# примитивный антибрутфорс: 5 промахов по логину -> пауза 60 сек
_fails = {}

def throttled(login: str) -> bool:
    n, t = _fails.get(login, (0, 0))
    return n >= 5 and time.time() - t < 60

def auth_login(req: Request) -> str | None:
    h = req.headers.get('authorization', '')
    if not h.startswith('Bearer '):
        return None
    token = h[7:]
    with closing(db()) as c:
        row = c.execute('SELECT login, expires_at FROM tokens WHERE token=?', (token,)).fetchone()
    if not row or row['expires_at'] < time.time():
        return None
    return row['login']

def require(req: Request):
    login = auth_login(req)
    if not login:
        return None, JSONResponse({'error': 'unauthorized'}, status_code=401)
    return login, None

# ---------- API ----------

class LoginIn(BaseModel):
    login: str
    password: str

@app.post('/api/login')
def login_ep(body: LoginIn):
    if throttled(body.login):
        return JSONResponse({'error': 'too_many_attempts'}, status_code=429)
    if not check_user(body.login, body.password):
        n, _ = _fails.get(body.login, (0, 0))
        _fails[body.login] = (n + 1, time.time())
        return JSONResponse({'error': 'bad_credentials'}, status_code=401)
    _fails.pop(body.login, None)
    token = secrets.token_urlsafe(32)
    with closing(db()) as c:
        c.execute('INSERT INTO tokens VALUES(?,?,?)',
                  (token, body.login, int(time.time()) + TOKEN_TTL))
        c.commit()
    return {'token': token}

@app.post('/api/logout')
async def logout_ep(req: Request):
    h = req.headers.get('authorization', '')
    if h.startswith('Bearer '):
        with closing(db()) as c:
            c.execute('DELETE FROM tokens WHERE token=?', (h[7:],))
            c.commit()
    return {'ok': True}

@app.get('/api/state')
def get_state(req: Request):
    login, err = require(req)
    if err: return err
    with closing(db()) as c:
        rows = c.execute('SELECT key, value FROM kv WHERE login=?', (login,)).fetchall()
    out = {'program': None, 'diary': None}
    for r in rows:
        out[r['key']] = json.loads(r['value'])
    return out

@app.put('/api/state')
async def put_state(req: Request):
    login, err = require(req)
    if err: return err
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({'error': 'bad_json'}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({'error': 'bad_json'}, status_code=400)
    now = int(time.time())
    with closing(db()) as c:
        for key in ('program', 'diary'):
            if key in body:
                c.execute(
                    'INSERT INTO kv(login,key,value,updated_at) VALUES(?,?,?,?) '
                    'ON CONFLICT(login,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
                    (login, key, json.dumps(body[key], ensure_ascii=False), now))
        c.commit()
    return {'ok': True}

class DescribeIn(BaseModel):
    name: str

DESCRIBE_PROMPT = (
    'Ты — лаконичный русскоязычный фитнес-ассистент. Опиши упражнение «{name}» '
    'в 2–3 коротких предложениях: как выполнять технично и какая ошибка самая частая. '
    'Без вступлений, без списков, без markdown. Только текст описания.'
)

@app.post('/api/describe')
async def describe_ep(body: DescribeIn, req: Request):
    login, err = require(req)
    if err: return err
    name = body.name.strip()[:120]
    if not name:
        return JSONResponse({'error': 'empty'}, status_code=400)
    with closing(db()) as c:
        row = c.execute('SELECT description FROM descr_cache WHERE name=?', (name,)).fetchone()
    if row:
        return {'description': row['description'], 'cached': True}
    if not GROQ_API_KEY:
        return JSONResponse({'error': 'no_groq_key'}, status_code=503)
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(
                'https://api.groq.com/openai/v1/chat/completions',
                headers={'Authorization': f'Bearer {GROQ_API_KEY}'},
                json={
                    'model': GROQ_MODEL,
                    'messages': [{'role': 'user', 'content': DESCRIBE_PROMPT.format(name=name)}],
                    'temperature': 0.3,
                    'max_tokens': 300,
                })
            r.raise_for_status()
            descr = r.json()['choices'][0]['message']['content'].strip()
    except Exception:
        return JSONResponse({'error': 'groq_failed'}, status_code=502)
    with closing(db()) as c:
        c.execute('INSERT OR REPLACE INTO descr_cache VALUES(?,?,?)', (name, descr, int(time.time())))
        c.commit()
    return {'description': descr, 'cached': False}

# ---------- импорт программы из файла ----------

IMPORT_PROMPT = '''Ты — парсер программ тренировок. Тебе дают текст программы (русский, может быть таблица или список).
Верни ТОЛЬКО JSON вида {"weeks":[...]} без пояснений. Схема недели:
{"n":1,"theme":"название недели","rpe":"нагрузка, например RPE 6–7 · 16 кг","hint":"короткая заметка к неделе",
"days":{"d1":{день},"d2":{день},"d3":{день},"d4":{день},"rest":{день отдыха}}}
Схема дня: {"title":"День 1 · название","focus":"фокус","dur":"время, например 60 мин",
"blocks":[{"t":"название блока","items":[{"n":"упражнение","s":"схема: подходы×повторы · вес · отдых","w":true}]}]}
Правила:
- тренировочных дней в неделе 1–4: раскладывай их по d1..d4 по порядку; если дней меньше 4 — оставшиеся сделай днями отдыха.
- день отдыха: {"title":"Отдых + мобилити","focus":"Восстановление","dur":"","rest":true,"blocks":[]}.
- "w": true, если упражнение с весом (гири, гантели, штанга); иначе false.
- "s" собирай из текста максимально коротко: "3×10 · 16 кг · отдых 60 с".
- если недель в тексте несколько — верни ВСЕ по порядку, нумерация n с 1, не пропускай ни одной.
- верни ВСЕ упражнения каждого дня, не сокращай.
- ничего не выдумывай: чего нет в тексте — оставляй пустым.
Текст программы:
'''

def docx_to_text(raw: bytes) -> str:
    """Текст из docx строго в порядке документа: абзацы и таблицы чередуются как в файле."""
    import docx, io
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    doc = docx.Document(io.BytesIO(raw))
    lines = []
    for child in doc.element.body.iterchildren():
        if child.tag.endswith('}p'):
            t = Paragraph(child, doc).text.strip()
            if t:
                lines.append(t)
        elif child.tag.endswith('}tbl'):
            for row_ in Table(child, doc).rows:
                cells = [c.text.strip().replace('\n', ' ') for c in row_.cells]
                lines.append(' | '.join(cells))
    return '\n'.join(lines)

def split_weeks(text: str) -> list:
    """Режет текст на куски по заголовкам 'Неделя N'. Если не нашёл — один кусок целиком."""
    parts = re.split(r'(?im)^\s*(?:\d+\s*[.\)]\s*)?(неделя\s*\d+\b[^\n]*)$', text)
    if len(parts) < 3:
        return [text]
    out = []
    for i in range(1, len(parts), 2):
        chunk = parts[i] + '\n' + parts[i + 1]
        if chunk.strip():
            out.append(chunk)
    return out or [text]

async def groq_parse_weeks(text: str) -> str:
    """Один запрос к Groq: текст -> JSON-строка. 429 — ждём и повторяем."""
    delay = 6.0
    for attempt in range(4):
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                r = await client.post(
                    'https://api.groq.com/openai/v1/chat/completions',
                    headers={'Authorization': f'Bearer {GROQ_API_KEY}'},
                    json={
                        'model': GROQ_MODEL,
                        'messages': [{'role': 'user', 'content': IMPORT_PROMPT + text}],
                        'temperature': 0.1,
                        'max_tokens': 8000,
                        'response_format': {'type': 'json_object'},
                    })
                r.raise_for_status()
                return r.json()['choices'][0]['message']['content']
        except httpx.HTTPStatusError as e:
            if e.response.status_code == 429 and attempt < 3:
                ra = e.response.headers.get('retry-after')
                try:
                    wait = float(ra) if ra else delay
                except ValueError:
                    wait = delay
                await asyncio.sleep(min(wait, 30.0))
                delay *= 2
                continue
            raise

def normalize_program(data):
    """Приводит ответ модели к нашей схеме; возвращает None, если совсем мимо."""
    try:
        weeks = data['weeks']
        assert isinstance(weeks, list) and weeks
    except Exception:
        return None
    out = []
    for i, w in enumerate(weeks):
        if not isinstance(w, dict):
            continue
        week = {
            'n': i + 1,
            'theme': str(w.get('theme') or f'Неделя {i + 1}')[:80],
            'rpe': str(w.get('rpe') or '')[:80],
            'hint': str(w.get('hint') or '')[:300],
            'days': {},
        }
        days_in = w.get('days') if isinstance(w.get('days'), dict) else {}
        for key in ('d1', 'd2', 'd3', 'd4', 'rest'):
            d = days_in.get(key)
            if not isinstance(d, dict):
                d = {}
            day = {
                'title': str(d.get('title') or ('Отдых' if key == 'rest' else f'День {key[1]}'))[:80],
                'focus': str(d.get('focus') or '')[:60],
                'dur': str(d.get('dur') or '')[:30],
                'blocks': [],
            }
            if d.get('rest') or key == 'rest':
                day['rest'] = True
            for b in (d.get('blocks') if isinstance(d.get('blocks'), list) else []):
                if not isinstance(b, dict):
                    continue
                block = {'t': str(b.get('t') or 'Основная часть')[:60], 'items': []}
                for ex in (b.get('items') if isinstance(b.get('items'), list) else []):
                    if not isinstance(ex, dict) or not ex.get('n'):
                        continue
                    block['items'].append({
                        'n': str(ex['n'])[:120],
                        's': str(ex.get('s') or '')[:200],
                        'w': bool(ex.get('w')),
                    })
                if block['items']:
                    day['blocks'].append(block)
            if key != 'rest' and not day['blocks']:
                day['rest'] = True  # день без упражнений — это отдых
            week['days'][key] = day
        out.append(week)
    return out or None

@app.post('/api/import-program')
async def import_program_ep(req: Request):
    login, err = require(req)
    if err: return err
    if not GROQ_API_KEY:
        return JSONResponse({'error': 'no_groq_key'}, status_code=503)
    fname = (req.headers.get('x-filename') or 'program.txt').lower()
    raw = await req.body()
    if not raw or len(raw) > 3_000_000:
        return JSONResponse({'error': 'bad_file'}, status_code=400)
    if fname.endswith('.docx'):
        try:
            text = docx_to_text(raw)
        except Exception:
            return JSONResponse({'error': 'bad_file'}, status_code=400)
    else:
        text = raw.decode('utf-8', errors='replace')
    text = text[:20000]
    if len(text.strip()) < 30:
        return JSONResponse({'error': 'empty'}, status_code=400)
    # длинный файл парсим по неделям: так модель ничего не теряет
    chunks = split_weeks(text)
    program = []
    failed = 0
    for chunk in chunks[:8]:  # максимум 8 недель
        part = None
        for _ in range(2):  # пустой/битый ответ — один повтор
            try:
                content = await groq_parse_weeks(chunk)
                part = normalize_program(json.loads(content))
            except Exception:
                part = None
            if part:
                break
        if part:
            program.extend(part)
        else:
            failed += 1  # неделя не разобралась — пропускаем, остальные спасаем
    if not program:
        return JSONResponse({'error': 'parse_failed'}, status_code=502)
    for i, w in enumerate(program):
        w['n'] = i + 1  # сквозная нумерация после склейки
    return {'program': program, 'skipped': failed}

# ---------- статика (само приложение) ----------

if os.path.isdir(WEB_DIR):
    app.mount('/', StaticFiles(directory=WEB_DIR, html=True), name='web')
