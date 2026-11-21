#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:?Set BASE_URL to staging URL}"
for path in /api/admin /api/admin/users /api/admin/plans /api/admin/payments /api/ops/monitor; do
 code=$(curl --max-time 10 -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
 [[ "$code" == 401 || "$code" == 403 ]] || { echo "Unexpected unauthenticated status $code for $path"; exit 1; }
done
# Inbox and session endpoints must also reject unauthenticated callers.
for path in /api/messages /api/auth/session; do
 code=$(curl --max-time 10 -s -o /dev/null -w '%{http_code}' "$BASE_URL$path")
 [[ "$code" == 401 ]] || { echo "Unexpected unauthenticated status $code for $path (expected 401)"; exit 1; }
done
# Suspended-user behaviour and token endpoints need authenticated checks;
# see docs/PRODUCTION-READINESS-STATUS.md for the manual test list.
curl --max-time 10 -fsS "$BASE_URL/api/health" >/dev/null
echo 'Unauthenticated-route smoke checks passed. This is not a penetration test.'
