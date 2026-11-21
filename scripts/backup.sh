#!/usr/bin/env bash
# WorkMail backup: D1 SQL dump + Cloudflare KV attachment VALUES,
# both age-encrypted, left as artifacts for the GitHub Actions workflow
# to upload (90-day retention). No object storage is involved anywhere:
# backups live only as encrypted workflow artifacts.
#
# Required env:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID — wrangler + KV REST auth
#   CLOUDFLARE_D1_DATABASE_ID                    — production D1 database
#   CLOUDFLARE_KV_NAMESPACE_ID                  — attachments namespace
#   AGE_RECIPIENT                               — age public key (age1...)
# Optional env:
#   KV_BACKUP_MAX_KEYS (default 500) — max attachment values to fetch;
#     any keys beyond the cap are counted and recorded, not silently lost.
#   BACKUP_OUT_DIR (default $PWD/workmail-backups) — where the encrypted
#     artifacts are written. Plaintext only ever lives in a temp dir.
#
# Outputs (printed at the end, and appended to $GITHUB_OUTPUT when set):
#   D1_BACKUP_ARTIFACT, KV_BACKUP_ARTIFACT — paths to the .age files.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?Set CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_D1_DATABASE_ID:?Set CLOUDFLARE_D1_DATABASE_ID}"
: "${CLOUDFLARE_KV_NAMESPACE_ID:?Set CLOUDFLARE_KV_NAMESPACE_ID}"
: "${AGE_RECIPIENT:?Set AGE_RECIPIENT (age public key)}"
KV_BACKUP_MAX_KEYS="${KV_BACKUP_MAX_KEYS:-500}"
OUT_DIR="${BACKUP_OUT_DIR:-$PWD/workmail-backups}"

for tool in wrangler age curl jq tar sha256sum; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORKDIR="$(mktemp -d)"
# Plaintext dumps/values live ONLY in $WORKDIR; the trap removes them even
# on failure, so a failed run can never leave a plaintext dump behind.
trap 'rm -rf "$WORKDIR"' EXIT
mkdir -p "$OUT_DIR"

KV_API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}"

# ---------------------------------------------------------------- D1 dump
D1_SQL="$WORKDIR/workmail-d1-${STAMP}.sql"
echo "Exporting D1 database ${CLOUDFLARE_D1_DATABASE_ID}..."
wrangler d1 export "$CLOUDFLARE_D1_DATABASE_ID" --remote --output="$D1_SQL"
[ -s "$D1_SQL" ] || { echo "D1 export produced an empty file" >&2; exit 1; }

D1_ARTIFACT="$OUT_DIR/workmail-d1-${STAMP}.sql.age"
age -r "$AGE_RECIPIENT" -o "$D1_ARTIFACT" "$D1_SQL"
sha256sum "$D1_ARTIFACT" > "${D1_ARTIFACT}.sha256"

# ------------------------------------------------- KV attachment VALUES
# Keys look like att/<workspaceId>/<mailboxId>/<uuid>-<safeName>.
# We back up the VALUES, not just the key list: a key list alone cannot
# restore an attachment. Values are fetched one by one over the KV REST
# API (free tier: 100k reads/day, 25 MB max value) and tarred.
echo "Listing KV keys..."
KEYS_FILE="$WORKDIR/kv-keys.txt"
: > "$KEYS_FILE"
CURSOR=""
while :; do
  LIST_URL="${KV_API}/keys?limit=1000"
  [ -n "$CURSOR" ] && LIST_URL="${LIST_URL}&cursor=${CURSOR}"
  LIST_JSON="$WORKDIR/kv-list.json"
  curl -sS --fail -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "$LIST_URL" -o "$LIST_JSON"
  [ "$(jq -r '.success' "$LIST_JSON")" = "true" ] \
    || { echo "KV key listing failed (API success != true)" >&2; exit 1; }
  jq -r '.result[]?.name' "$LIST_JSON" >> "$KEYS_FILE"
  CURSOR="$(jq -r '.result_info.cursor // empty' "$LIST_JSON")"
  [ -z "$CURSOR" ] && break
done
TOTAL_KEYS="$(wc -l < "$KEYS_FILE" | tr -d ' ')"
echo "Found ${TOTAL_KEYS} KV keys; cap is ${KV_BACKUP_MAX_KEYS}."

KV_STAGE="$WORKDIR/kv-values"
mkdir -p "$KV_STAGE"
BACKED_UP=0
while IFS= read -r KEY; do
  [ -z "$KEY" ] && continue
  if [ "$BACKED_UP" -ge "$KV_BACKUP_MAX_KEYS" ]; then break; fi
  ENCODED_KEY="$(printf '%s' "$KEY" | jq -sRr @uri)"
  DEST="$KV_STAGE/$KEY"
  mkdir -p "$(dirname "$DEST")"
  curl -sS --fail -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "${KV_API}/values/${ENCODED_KEY}" -o "$DEST"
  BACKED_UP=$((BACKED_UP + 1))
done < "$KEYS_FILE"
SKIPPED=$((TOTAL_KEYS - BACKED_UP))
{
  echo "stamp: ${STAMP}"
  echo "total_keys_listed: ${TOTAL_KEYS}"
  echo "values_backed_up: ${BACKED_UP}"
  echo "skipped_over_cap: ${SKIPPED}"
  echo "cap: ${KV_BACKUP_MAX_KEYS}"
} > "$KV_STAGE/BACKUP-MANIFEST.txt"
cp "$KEYS_FILE" "$KV_STAGE/BACKUP-KEYS.txt"
if [ "$SKIPPED" -gt 0 ]; then
  echo "WARNING: ${SKIPPED} KV keys skipped (cap ${KV_BACKUP_MAX_KEYS}); raise KV_BACKUP_MAX_KEYS to include them." >&2
fi

KV_TAR="$WORKDIR/workmail-kv-${STAMP}.tar"
tar -cf "$KV_TAR" -C "$KV_STAGE" .
KV_ARTIFACT="$OUT_DIR/workmail-kv-${STAMP}.tar.age"
age -r "$AGE_RECIPIENT" -o "$KV_ARTIFACT" "$KV_TAR"
sha256sum "$KV_ARTIFACT" > "${KV_ARTIFACT}.sha256"

echo "D1_BACKUP_ARTIFACT=${D1_ARTIFACT}"
echo "KV_BACKUP_ARTIFACT=${KV_ARTIFACT}"
echo "D1 backup: ${D1_ARTIFACT} (sha256 in ${D1_ARTIFACT}.sha256)"
echo "KV backup: ${KV_ARTIFACT} (sha256 in ${KV_ARTIFACT}.sha256; ${BACKED_UP} values, ${SKIPPED} skipped)"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "d1_backup_artifact=${D1_ARTIFACT}"
    echo "kv_backup_artifact=${KV_ARTIFACT}"
  } >> "$GITHUB_OUTPUT"
fi
