#!/bin/bash
# Ежедневный бэкап базы спорт-дневника.
# Снапшот через SQLite online backup (безопасно на живой базе), храним 14 последних копий.
set -e

# Путь к базе: из systemd-юнита (SPORT_DB), иначе дефолт рядом с main.py
DB=$(systemctl cat sport 2>/dev/null | grep -oP 'SPORT_DB=\K[^"\s]+' | head -1)
DB=${DB:-/opt/sport/server/data.db}

DIR=/opt/sport/backups
mkdir -p "$DIR"
TS=$(date +%Y%m%d-%H%M%S)

python3 - "$DB" "$DIR/sport-$TS.db" << 'PYEOF'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(src)
d = sqlite3.connect(dst)
s.backup(d)
d.close(); s.close()
PYEOF

# оставляем 14 последних копий
ls -1t "$DIR"/sport-*.db | tail -n +15 | xargs -r rm -f

echo "backup ok: $DIR/sport-$TS.db"
