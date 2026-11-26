#!/usr/bin/env python3
"""Управление аккаунтами: python3 admin.py <команда> [аргументы]

  create <логин> [пароль]   — создать аккаунт (пароль сгенерируется, если не задан)
  passwd <логин> [пароль]   — сменить пароль
  delete <логин>            — удалить аккаунт и ВСЕ его данные
  promote <логин>           — сделать админом (веб-админка: создание/сброс/удаление аккаунтов)
  demote <логин>            — снять права админа
  list                      — список аккаунтов
"""
import os
import secrets
import string
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('SPORT_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.db'))

import bcrypt
from main import db, create_user
import time

def gen_password(n=10):
    abc = string.ascii_letters + string.digits
    return ''.join(secrets.choice(abc) for _ in range(n))

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    cmd = sys.argv[1]

    if cmd == 'create':
        if len(sys.argv) < 3:
            print('нужен логин: python3 admin.py create <логин>')
            return
        login, pw = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else gen_password())
        if create_user(login, pw):
            print(f'аккаунт создан:\n  логин:  {login}\n  пароль: {pw}')
        else:
            print('такой логин уже существует')

    elif cmd == 'passwd':
        if len(sys.argv) < 3:
            print('нужен логин: python3 admin.py passwd <логин>')
            return
        login, pw = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else gen_password())
        with db() as c:
            cur = c.execute('UPDATE users SET passhash=? WHERE login=?',
                            (bcrypt.hashpw(pw.encode(), bcrypt.gensalt()), login))
            c.execute('DELETE FROM tokens WHERE login=?', (login,))
            c.commit()
        print(f'пароль обновлён:\n  логин:  {login}\n  пароль: {pw}' if cur.rowcount else 'аккаунт не найден')

    elif cmd == 'delete':
        if len(sys.argv) < 3:
            print('нужен логин: python3 admin.py delete <логин>')
            return
        login = sys.argv[2]
        with db() as c:
            c.execute('DELETE FROM users WHERE login=?', (login,))
            c.execute('DELETE FROM tokens WHERE login=?', (login,))
            c.execute('DELETE FROM kv WHERE login=?', (login,))
            c.commit()
        print(f'аккаунт {login} и его данные удалены')

    elif cmd == 'promote' or cmd == 'demote':
        if len(sys.argv) < 3:
            print(f'нужен логин: python3 admin.py {cmd} <логин>')
            return
        login = sys.argv[2]
        with db() as c:
            cur = c.execute('UPDATE users SET is_admin=? WHERE login=?',
                            (1 if cmd == 'promote' else 0, login))
            c.commit()
        print(f'{login} теперь админ' if cur.rowcount and cmd == 'promote'
              else f'{login} больше не админ' if cur.rowcount else 'аккаунт не найден')

    elif cmd == 'list':
        with db() as c:
            rows = c.execute('SELECT login, created_at, is_admin FROM users ORDER BY created_at').fetchall()
        if not rows:
            print('аккаунтов пока нет')
        for r in rows:
            adm = ' ★админ' if 'is_admin' in r.keys() and r['is_admin'] else ''
            print(f"  {r['login']}{adm}  (создан {time.strftime('%d.%m.%Y', time.localtime(r['created_at']))})")
    else:
        print(__doc__)

if __name__ == '__main__':
    main()
