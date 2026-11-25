# СПОРТ.ДНЕВНИК — серверная часть
# FastAPI + SQLite: аккаунты, хранилище программы/дневника, прокси к Groq
import json
import os
import secrets
import sqlite3
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
GROQ_MODEL = os.environ.get('GROQ_MODEL', 'llama-3.3-70b-versatile')
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

# ---------- статика (само приложение) ----------

if os.path.isdir(WEB_DIR):
    app.mount('/', StaticFiles(directory=WEB_DIR, html=True), name='web')
