#!/usr/bin/env bash
# WorkMail restore drill — D1 SQL dump into a DISPOSABLE database.
#
# STAGING ONLY. This script NEVER restores into production: it refuses to
# run unless RESTORE_D1_DATABASE_ID is set AND differs from
# CLOUDFLARE_D1_DATABASE_ID (the production database id).
#
# Required env:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — wrangler auth
#   CLOUDFLARE_D1_DATABASE_ID  — production D1 id (used ONLY as the
#     never-restore-here guard; nothing is written to it)
#   RESTORE_D1_DATABASE_ID     — disposable D1 database id. Create one
#     for the drill (`wrangler d1 create workmail-restore-drill`) and
#     delete it afterwards (`wrangler d1 delete <id>`).
#   BACKUP_FILE                — encrypted D1 dump (.age) or plain SQL (.sql)
#   AGE_IDENTITY               — age private-key file (only for .age files)
#
# What it does:
#   1. Decrypts the .age dump into a temp dir (trap-cleaned on exit).
#   2. Loads it into the disposable database with
#      `wrangler d1 execute <restore-db> --remote --file=<dump.sql>`.
#   3. Verifies with row counts from workspaces and messages and prints them.
#
# KV attachment VALUES are restored separately from the KV artifact
# (workmail-kv-<stamp>.tar.age): decrypt it, untar it, then PUT each value
# back with the KV REST API —
#   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$CLOUDFLARE_KV_NAMESPACE_ID/values/<url-encoded-key>"
#     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" --data-binary @"<file>"
# — into a disposable namespace first, and only point the app at it after
# the D1 counts above verify. KV restore is NOT done by this script.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_D1_DATABASE_ID:?Set CLOUDFLARE_D1_DATABASE_ID (production id — the never-restore-here guard)}"
: "${RESTORE_D1_DATABASE_ID:?Set RESTORE_D1_DATABASE_ID to a disposable D1 database id}"
: "${BACKUP_FILE:?Set BACKUP_FILE to the backup file (.age encrypted or plain .sql)}"

for tool in wrangler age python3; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

if [ "$RESTORE_D1_DATABASE_ID" = "$CLOUDFLARE_D1_DATABASE_ID" ]; then
  echo "Refusing restore: RESTORE_D1_DATABASE_ID equals CLOUDFLARE_D1_DATABASE_ID (production). Use a disposable database." >&2
  exit 1
fi
[ -f "$BACKUP_FILE" ] || { echo "BACKUP_FILE not found: $BACKUP_FILE" >&2; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
PLAIN_SQL="$WORKDIR/restore.sql"
case "$BACKUP_FILE" in
  *.age)
    : "${AGE_IDENTITY:?Set AGE_IDENTITY to the age private-key file to decrypt .age backups}"
    age -d -i "$AGE_IDENTITY" -o "$PLAIN_SQL" "$BACKUP_FILE"
    ;;
  *.sql)
    cp "$BACKUP_FILE" "$PLAIN_SQL"
    ;;
  *)
    echo "Refusing restore: BACKUP_FILE must end in .age or .sql: $BACKUP_FILE" >&2
    exit 1
    ;;
esac
[ -s "$PLAIN_SQL" ] || { echo "Decrypted/copied dump is empty" >&2; exit 1; }

echo "Restoring into disposable D1 database ${RESTORE_D1_DATABASE_ID}..."
wrangler d1 execute "$RESTORE_D1_DATABASE_ID" --remote --file="$PLAIN_SQL"

echo "Verifying restored database..."
WS_COUNT="$(wrangler d1 execute "$RESTORE_D1_DATABASE_ID" --remote --json --command="SELECT count(*) AS n FROM workspaces;" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")"
MSG_COUNT="$(wrangler d1 execute "$RESTORE_D1_DATABASE_ID" --remote --json --command="SELECT count(*) AS n FROM messages;" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")"
echo "Restore drill completed: workspaces=${WS_COUNT} messages=${MSG_COUNT} in disposable database ${RESTORE_D1_DATABASE_ID}."
echo "Next: run tests/tenant-isolation.sql against this restored database, then delete the disposable database (wrangler d1 delete ${RESTORE_D1_DATABASE_ID})."
echo "KV values restore separately from the KV artifact — see the header of this script."
