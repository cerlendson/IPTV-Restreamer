#!/bin/sh
set -eu

PUID="${PUID:-99}"
PGID="${PGID:-100}"

case "$PUID" in
  *[!0-9]*|"") PUID=99 ;;
esac

case "$PGID" in
  *[!0-9]*|"") PGID=100 ;;
esac

if ! getent group "$PGID" >/dev/null 2>&1; then
  groupadd -g "$PGID" iptv >/dev/null 2>&1
fi

APP_GROUP="$(getent group "$PGID" | cut -d: -f1)"

if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  usermod -o -u "$PUID" -g "$PGID" node >/dev/null 2>&1
fi

mkdir -p "$DATA_DIR" "$STORAGE_DIR" "$HLS_DIR"
chown -R node:"$APP_GROUP" "$DATA_DIR" "$STORAGE_DIR"

exec gosu node "$@"
