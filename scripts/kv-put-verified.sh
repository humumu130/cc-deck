#!/usr/bin/env bash
# KV 带校验上传：put 后强制回读 md5 比对 + zip 类产物 unzip -t
# 2026-09-17 test.1 APK 坏文件事故的防再犯（KV 上的包损坏 → 用户装机即闪退，
# 且下载端"下载到99%重头循环"曾误导向更新链——坏文件必须在上传时拦截）
#   用法：scripts/kv-put-verified.sh <本地文件> <KV key>
set -euo pipefail
cd "$(dirname "$0")/.."

FILE="${1:?用法: kv-put-verified.sh <本地文件> <KV key>}"
KEY="${2:?缺少 KV key}"
KV_NS="d9b9bb1768324fb1b71907ca72de7aa6"
CF_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:?缺 CF_TOKEN/CLOUDFLARE_API_TOKEN}}"
DOMAIN="https://cc.humumu.online"

[ -f "$FILE" ] || { echo "ERR: 本地文件不存在 $FILE"; exit 1; }
FILE=$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")  # wrangler 在 cloudflare/ 下执行，路径必须绝对
case "$FILE" in
  *.apk|*.zip) unzip -t "$FILE" >/dev/null || { echo "ERR: 本地 zip 已损坏，禁止上传"; exit 1; } ;;
esac
LOCAL_MD5=$(md5 -q "$FILE")
LOCAL_SIZE=$(stat -f%z "$FILE")
FN=$(basename "$FILE")

echo "[1/3] put $KEY ← $(basename "$FILE") (${LOCAL_SIZE}B)"
(cd cloudflare && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler kv key put "$KEY" \
  --path "$FILE" --namespace-id "$KV_NS" --remote \
  --metadata "{\"filename\":\"$FN\"}" >/dev/null)

echo "[2/3] 回读校验"
TMP=$(mktemp /tmp/kv-verify.XXXXXX)
# 家里到 CF 的下载速度波动大（实测 80KB/s~5.7MB/s），120s 曾把大文件校验误判成超时
curl -sS --max-time 300 -o "$TMP" "$DOMAIN/dl/$KEY"
REMOTE_MD5=$(md5 -q "$TMP"); REMOTE_SIZE=$(stat -f%z "$TMP"); rm -f "$TMP"

echo "[3/3] 比对"
[ "$LOCAL_MD5" = "$REMOTE_MD5" ] || { echo "ERR: md5 不一致 local=$LOCAL_MD5 remote=$REMOTE_MD5"; exit 1; }
[ "$LOCAL_SIZE" = "$REMOTE_SIZE" ] || { echo "ERR: 大小不一致 local=${LOCAL_SIZE}B remote=${REMOTE_SIZE}B"; exit 1; }
case "$KEY" in
  *.apk|*.zip) TMP=$(mktemp /tmp/kv-zipt.XXXXXX); curl -sS --max-time 300 -o "$TMP" "$DOMAIN/dl/$KEY"; unzip -t "$TMP" >/dev/null || { rm -f "$TMP"; echo "ERR: 回读 zip 损坏"; exit 1; }; rm -f "$TMP"; ;;
esac
echo "✅ KV 上传校验通过：$KEY ($LOCAL_MD5, ${LOCAL_SIZE}B)"
echo "   直链: $DOMAIN/dl/$KEY"
