#!/usr/bin/env bash
# KV 带校验上传：put 后强制回读 md5 比对 + zip 类产物 unzip -t
# 2026-09-17 test.1 APK 坏文件事故的防再犯（KV 上的包损坏 → 用户装机即闪退，
# 且下载端"下载到99%重头循环"曾误导向更新链——坏文件必须在上传时拦截）
#   用法：scripts/kv-put-verified.sh <本地文件> <KV key>
set -euo pipefail
# #239 加固①：GUI 会话 shell 的 PATH 常缺 /sbin（macOS md5 在 /sbin/md5，#232 同款教训）
# ——缺了会假报 command not found 且 set -e 直接退出成假失败
PATH="/sbin:/usr/sbin:/usr/bin:/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

FILE="${1:?用法: kv-put-verified.sh <本地文件> <KV key>}"
KEY="${2:?缺少 KV key}"
KV_NS="d9b9bb1768324fb1b71907ca72de7aa6"
CF_ACCOUNT="0c1742f1daa27d42b5e7a150d685c15a"
CF_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:?缺 CF_TOKEN/CLOUDFLARE_API_TOKEN}}"
# wrangler 代理回落（2026-09-22）：api.cloudflare.com 被墙时 wrangler 直连超时
#（undici 不吃 http_proxy env，test.24/25 连续两晚上传失败）——curl 走本地代理打
# REST API 等价上传，末尾 md5 回读校验照旧兜底
CF_PROXY="${CC_CF_PROXY:-http://127.0.0.1:7890}"
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
if ! (cd cloudflare && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler kv key put "$KEY" \
    --path "$FILE" --namespace-id "$KV_NS" --remote \
    --metadata "{\"filename\":\"$FN\"}" >/dev/null 2>&1); then
  echo "    wrangler 直连失败，回落 curl+代理（$CF_PROXY）"
  curl -sS --max-time 600 -x "$CF_PROXY" \
    -H "Authorization: Bearer $CF_TOKEN" -X PUT --data-binary "@$FILE" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY" \
    | grep -q '"success":true' || { echo "ERR: KV 上传失败（wrangler 与 curl 代理均失败）"; exit 1; }
fi

# 回读校验（2026-09-23 #154 加重试；#28 收窄适配 + #239 加固②）：
# #28（2026-10-01）回读改走 CF REST API：/dl/ 公网面对验收单密钥键（*.key）与
# results 键已 404 收窄（防未认证读密钥/结果），/dl/ 域名回读会让 .key 上传永远
# 校验失败——API 读与上传同权限同通道（被墙时同走代理），对公网读面零依赖，
# 且绕开边缘传播窗的旧值假报。#239 实锤（0.6.3 发版）存储层最终一致传播窗可超
# 90s——窗口 4×6s 拉长为 6×15s，耗尽后 wrangler 直读二次确认再判真失败。
kv_api_read() {
  # 双路：api.cloudflare.com 直连优先（同 wrangler 主路径），失败回落本地代理
  #（同上传回落通道；-f 让 4xx/5xx 变非零触发重试，不把错误体当键值比对）
  curl -sf --max-time 300 -H "Authorization: Bearer $CF_TOKEN" -o "$1" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY" \
  || curl -sf --max-time 300 -x "$CF_PROXY" -H "Authorization: Bearer $CF_TOKEN" -o "$1" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY"
}
echo "[2/3] 回读校验（CF API 直读存储，最终一致窗口 6×15s）"
TMP=$(mktemp /tmp/kv-verify.XXXXXX)
REMOTE_MD5=""; REMOTE_SIZE=""; VERIFY_OK=0
for i in 1 2 3 4 5 6; do
  # 家里到 CF 的下载速度波动大（实测 80KB/s~5.7MB/s），120s 曾把大文件校验误判成超时
  if kv_api_read "$TMP"; then
    REMOTE_MD5=$(md5 -q "$TMP"); REMOTE_SIZE=$(stat -f%z "$TMP")
    if [ "$LOCAL_MD5" = "$REMOTE_MD5" ] && [ "$LOCAL_SIZE" = "$REMOTE_SIZE" ]; then VERIFY_OK=1; break; fi
  fi
  [ "$i" = "6" ] || { echo "    第 $i 次回读未一致（remote=$REMOTE_MD5），15s 后重读"; sleep 15; }
done

# 域名边缘窗口耗尽仍未一致 → 直读 KV 存储本体分辨真伪（绕过域名边缘）：
#   直读已是新值 = put 成功、边缘传播中，不算失败（~60s 后域名自然出新）
#   直读也是旧值/为空 = 真上传失败
# 直读双路：wrangler 主路（stdout 重定向取二进制——--outfile 旗标不被识别），
# curl+代理 REST 回落（api.cloudflare.com 被墙时 wrangler 直连超时，与上传回落对称）
if [ "$VERIFY_OK" != "1" ]; then
  echo "    域名回读未一致，直读 KV 存储分辨（传播窗 vs 真失败）…"
  KVDIRECT=$(mktemp /tmp/kv-direct.XXXXXX)
  DIRECT_OK=0
  if (cd cloudflare && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler kv key get "$KEY" \
      --namespace-id "$KV_NS" --remote >"$KVDIRECT" 2>/dev/null) \
      && [ "$(md5 -q "$KVDIRECT")" = "$LOCAL_MD5" ] && [ "$(stat -f%z "$KVDIRECT")" = "$LOCAL_SIZE" ]; then
    DIRECT_OK=1
  elif curl -sS --max-time 120 -x "$CF_PROXY" -H "Authorization: Bearer $CF_TOKEN" \
      -o "$KVDIRECT" "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY" 2>/dev/null \
      && [ "$(md5 -q "$KVDIRECT")" = "$LOCAL_MD5" ] && [ "$(stat -f%z "$KVDIRECT")" = "$LOCAL_SIZE" ]; then
    DIRECT_OK=1
  fi
  if [ "$DIRECT_OK" = "1" ]; then
    rm -f "$TMP" "$KVDIRECT"
    echo "✅ KV 上传实际成功（存储直读一致 $LOCAL_MD5）——域名边缘传播中，~60s 后自然出新，非失败"
    echo "   直链: $DOMAIN/dl/$KEY"
    exit 0
  fi
  rm -f "$KVDIRECT"
fi
rm -f "$TMP"

echo "[3/3] 比对"
[ "$VERIFY_OK" = "1" ] || { echo "ERR: 回读不一致 local=$LOCAL_MD5/${LOCAL_SIZE}B remote=$REMOTE_MD5/${REMOTE_SIZE:-0}B"; exit 1; }
case "$KEY" in
  *.apk|*.zip) TMP=$(mktemp /tmp/kv-zipt.XXXXXX); curl -sS --max-time 300 -o "$TMP" "$DOMAIN/dl/$KEY"; unzip -t "$TMP" >/dev/null || { rm -f "$TMP"; echo "ERR: 回读 zip 损坏"; exit 1; }; rm -f "$TMP"; ;;
esac
echo "✅ KV 上传校验通过：$KEY ($LOCAL_MD5, ${LOCAL_SIZE}B)"
# #28：.key/.results.json 键 /dl/ 已 404（安全收窄），不打误导直链
case "$KEY" in
  *.key|*.results.json) ;;
  *) echo "   直链: $DOMAIN/dl/$KEY" ;;
esac
