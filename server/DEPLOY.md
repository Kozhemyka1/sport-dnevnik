# Деплой на сервер (Hostkey, Ubuntu 24.04)

Всё делается по SSH под root. Примерное время — 15 минут.

## 1. Подготовка

```bash
apt update && apt install -y python3-venv git curl
```

## 2. Код на сервер

```bash
mkdir -p /opt/sport
cd /opt/sport
git clone https://github.com/Kozhemyka1/sport-dnevnik.git repo

# серверная часть:
cp -r repo/app/server /opt/sport/server

# фронт (его раздаёт сервер из папки web/):
mkdir -p /opt/sport/server/web
cp -r repo/app/index.html repo/app/src repo/app/*.png repo/app/manifest.json /opt/sport/server/web/
```

## 3. Python-окружение и зависимости

```bash
cd /opt/sport/server
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## 4. Ключ Groq

В файле `sport.service` замени `ВСТАВЬ_КЛЮЧ_GROQ` на свой ключ с console.groq.com.

## 5. Автозапуск сервиса

```bash
cp /opt/sport/server/sport.service /etc/systemd/system/sport.service
systemctl daemon-reload
systemctl enable --now sport
systemctl status sport      # должно быть active (running)
```

Проверка: `curl http://127.0.0.1:8080/api/state` → ответ `{"detail":"..."}` или 401 — сервис жив.

## 6. Caddy и HTTPS

```bash
apt install -y caddy
```

Caddyfile уже настроен на `pixelsport.duckdns.org`. Просто:

```bash
cp /opt/sport/server/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy сам получит сертификат Let's Encrypt. Проверка: открыть `https://pixelsport.duckdns.org` — должно открыться приложение.

## 7. Создать аккаунты

```bash
cd /opt/sport/server
./venv/bin/python admin.py create nikita
# выведет пароль — это твой вход в приложение
./venv/bin/python admin.py list
```

## Обновление приложения (после изменений в репо)

```bash
cd /opt/sport/repo && git pull
cp -r app/index.html app/src app/*.png app/manifest.json /opt/sport/server/web/
systemctl restart sport
```

## Бэкап базы (раз в день)

```bash
crontab -e
# добавить строку:
17 4 * * * cp /opt/sport/server/data.db /opt/sport/backups/data-$(date +\%F).db
```
(предварительно `mkdir -p /opt/sport/backups`)
