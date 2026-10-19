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
CF_ACCOUNT="0c1742f1daa27d42b5e7a150d685c15a"
CF_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:?缺 CF_TOKEN/CLOUDFLARE_API_TOKEN}}"
# wrangler 代理回落（2026-09-22）：api.cloudflare.com 被墙时 wrangler 直连超时
#（undici 不吃 http_proxy env，test.24/25 连续两晚上传失败）——curl 走本地代理打
# REST API 等价上传，末尾 md5 回读校验照旧兜底
CF_PROXY="${CC_CF_PROXY:-http://127.0.0.1:7890}"
DOMAIN="https://cc.humumu.online"

[ -f "$FILE" ] || { echo "ERR: 本地文件不存在 $FILE"; exit 1; }
FILE=$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")  # wrangler 在 cloudflare/ 下执行，路径必须绝对
# md5 helper（2026-10-10）：Mac 无 PATH 内 md5/md5sum（check-bundle-sync P1b 同坑，
# 本脚本漏修）——python3 系统自带，分块读避免大文件内存尖峰
md5_of() { python3 -c '
import hashlib, sys
h = hashlib.md5()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
print(h.hexdigest())' "$1"; }
case "$FILE" in
  *.apk|*.zip) unzip -t "$FILE" >/dev/null || { echo "ERR: 本地 zip 已损坏，禁止上传"; exit 1; } ;;
esac
LOCAL_MD5=$(md5_of "$FILE")
LOCAL_SIZE=$(stat -f%z "$FILE")
FN=$(basename "$FILE")

echo "[1/3] put $KEY ← $(basename "$FILE") (${LOCAL_SIZE}B)"
if ! (cd cloudflare && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler kv key put "$KEY" \
    --path "$FILE" --namespace-id "$KV_NS" --remote \
    --metadata "{\"filename\":\"$FN\"}" >/dev/null 2>&1); then
  echo "    wrangler 直连失败，回落 curl+代理（${CF_PROXY}）"
  curl -sS --max-time 600 -x "$CF_PROXY" \
    -H "Authorization: Bearer $CF_TOKEN" -X PUT --data-binary "@$FILE" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY" \
    | grep -q '"success":true' || { echo "ERR: KV 上传失败（wrangler 与 curl 代理均失败）"; exit 1; }
fi

# 回读校验（2026-09-23 #154 加重试）：CF KV 是最终一致——put 成功后立即回读，
# 边缘可能仍返回旧值 → md5 不匹配被误判「上传失败」（test.28 发布实证：put 实际
# 成功、清单滞留旧版让 App 检查更新拿到旧包）。不匹配隔 6s 重读最多 4 次；仍不
# 一致才算真失败（坏上传不会被重试掩盖）
# #28（2026-10-01）回读改走 CF REST API：/dl/ 公网面对验收单密钥键（*.key）与
# results 键已 404 收窄（防未认证读密钥/结果），/dl/ 回读会让 .key 上传永远
# 校验失败——API 读与上传同权限同通道（被墙时同走代理），对公网读面零依赖。
kv_api_read() {
  # 双路：api.cloudflare.com 直连优先（同 wrangler 主路径），失败回落本地代理
  #（同上传回落通道；-f 让 4xx/5xx 变非零触发重试，不把错误体当键值比对）
  curl -sf --max-time 300 -H "Authorization: Bearer $CF_TOKEN" -o "$1" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY" \
  || curl -sf --max-time 300 -x "$CF_PROXY" -H "Authorization: Bearer $CF_TOKEN" -o "$1" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY"
}
echo "[2/3] 回读校验（CF API / 大文件 Range 抽查，KV 最终一致，最多重试 4 次）"
TMP=$(mktemp /tmp/kv-verify.XXXXXX)
REMOTE_MD5=""; REMOTE_SIZE=""; VERIFY_OK=0
# F4（2026-10-19）校验分档：≤8MB 全量回读 md5（强校验不变）；大文件 Range 抽查判完整。
# 根因：家里→CF 下载速度波动大（实测 80KB/s~5.7MB/s），大文件全量回读在慢链路动辄超
# 300s——上传成功被误报成失败（test.44 apk 实锤）；「md5 全对仍报损坏」同根源（[3/3]
# 公网复检全量下载截断 → unzip -t 必败）。大文件改查完整性：Content-Range 总长==本地
# + 首尾 1KB 与本地逐字节一致（尾 1KB 覆盖 zip EOCD；KV put 是整体写，截断只可能发生
# 在校验下载侧，两端 1KB 锚点即可判完整，无需全量 md5）
SMALL_MAX=$((8 * 1024 * 1024))
if [ "$LOCAL_SIZE" -le "$SMALL_MAX" ]; then
  for i in 1 2 3 4; do
    if kv_api_read "$TMP"; then
      REMOTE_MD5=$(md5_of "$TMP"); REMOTE_SIZE=$(stat -f%z "$TMP")
      if [ "$LOCAL_MD5" = "$REMOTE_MD5" ] && [ "$LOCAL_SIZE" = "$REMOTE_SIZE" ]; then VERIFY_OK=1; break; fi
    fi
    [ "$i" = "4" ] || { echo "    第 $i 次回读未一致（remote=${REMOTE_MD5}），6s 后重读"; sleep 6; }
  done
else
  # 大文件档：/dl/ 公网面 Range 抽查（E2 起 worker 支持 206/Content-Range；#28 的
  # /dl/ 收窄只针对 .key/.results.json，apk/zip/exe 键公网可读）
  H_LOCAL=$(mktemp /tmp/kv-hl.XXXXXX); T_LOCAL=$(mktemp /tmp/kv-tl.XXXXXX)
  H_REMOTE=$(mktemp /tmp/kv-hr.XXXXXX); T_REMOTE=$(mktemp /tmp/kv-tr.XXXXXX)
  head -c 1024 "$FILE" > "$H_LOCAL"; tail -c 1024 "$FILE" > "$T_LOCAL"
  RANGE_OK=0
  for i in 1 2 3 4; do
    TOTAL=$(curl -sf --max-time 60 -r 0-0 -D - -o /dev/null "$DOMAIN/dl/$KEY" 2>/dev/null \
      | tr -d '\r' | grep -i '^content-range:' | sed 's|.*/||' || true)
    if [ "$TOTAL" = "$LOCAL_SIZE" ] \
      && curl -sf --max-time 120 -r 0-1023 -o "$H_REMOTE" "$DOMAIN/dl/$KEY" 2>/dev/null \
      && curl -sf --max-time 120 -r "$((LOCAL_SIZE-1024))-$((LOCAL_SIZE-1))" -o "$T_REMOTE" "$DOMAIN/dl/$KEY" 2>/dev/null \
      && [ "$(md5_of "$H_REMOTE")" = "$(md5_of "$H_LOCAL")" ] \
      && [ "$(md5_of "$T_REMOTE")" = "$(md5_of "$T_LOCAL")" ]; then
      RANGE_OK=1; break
    fi
    [ "$i" = "4" ] || { echo "    第 $i 次 Range 抽查未一致（remote 总长=${TOTAL:-未知}），6s 后重试"; sleep 6; }
  done
  if [ "$RANGE_OK" = "1" ]; then
    VERIFY_OK=1; REMOTE_SIZE="$LOCAL_SIZE"; REMOTE_MD5="${LOCAL_MD5}(range 抽查判完整)"
  else
    # Range 面全挂（/dl/ 不可达、Range 不支持等）：回落全量 API 回读，超时放宽 600s 兜底
    #（双路与 kv_api_read 同款：直连优先，被墙回落本地代理——E8 形态）
    echo "    Range 抽查未通过，回落全量 API 回读（大文件慢链路可能需数分钟）"
    for i in 1 2 3 4; do
      if curl -sf --max-time 600 -H "Authorization: Bearer $CF_TOKEN" -o "$TMP" \
        "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY" \
      || curl -sf --max-time 600 -x "$CF_PROXY" -H "Authorization: Bearer $CF_TOKEN" -o "$TMP" \
        "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/storage/kv/namespaces/$KV_NS/values/$KEY"; then
        REMOTE_MD5=$(md5_of "$TMP"); REMOTE_SIZE=$(stat -f%z "$TMP")
        if [ "$LOCAL_MD5" = "$REMOTE_MD5" ] && [ "$LOCAL_SIZE" = "$REMOTE_SIZE" ]; then VERIFY_OK=1; break; fi
      fi
      [ "$i" = "4" ] || { echo "    第 $i 次全量回读未一致，6s 后重读"; sleep 6; }
    done
  fi
  rm -f "$H_LOCAL" "$T_LOCAL" "$H_REMOTE" "$T_REMOTE"
fi
rm -f "$TMP"

echo "[3/3] 比对"
[ "$VERIFY_OK" = "1" ] || { echo "ERR: 回读不一致 local=$LOCAL_MD5/${LOCAL_SIZE}B remote=$REMOTE_MD5/${REMOTE_SIZE:-0}B"; exit 1; }
case "$KEY" in
  *.apk|*.zip)
    # F4 分档：小文件保留全量下载 + unzip -t 公网复检（快且强）；大文件跳过——
    # Range 抽查已判完整（尾 1KB 含 zip EOCD 与本地一致），慢链路全量下载复检正是
    # 「md5 全对仍报损坏」误报的源头（下载截断 → unzip 必败）
    if [ "$LOCAL_SIZE" -le "$SMALL_MAX" ]; then
      TMP=$(mktemp /tmp/kv-zipt.XXXXXX); curl -sS --max-time 300 -o "$TMP" "$DOMAIN/dl/$KEY"; unzip -t "$TMP" >/dev/null || { rm -f "$TMP"; echo "ERR: 回读 zip 损坏"; exit 1; }; rm -f "$TMP"
    fi ;;
esac
echo "✅ KV 上传校验通过：$KEY ($LOCAL_MD5, ${LOCAL_SIZE}B)"
# #28：.key/.results.json 键 /dl/ 已 404（安全收窄），不打误导直链
case "$KEY" in
  *.key|*.results.json) ;;
  *) echo "   直链: $DOMAIN/dl/$KEY" ;;
esac
