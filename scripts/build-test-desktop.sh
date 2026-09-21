#!/usr/bin/env bash
# test 版桌面端发版收尾（#119 test 通道在线更新链）：
#   用法：scripts/build-test-desktop.sh <ver>（如 0.6.0-test.13）
# 前置：仓库已提交并推 tag v<ver>（desktop.yml 的 -test 分支会把 updater endpoint
#       烙成 tauri-latest-test.json，见该 workflow "Sync version from tag" 步骤）
# 动作：[1/5] 等 desktop.yml 的 tag run 跑完 → [2/5] 拉 artifact（setup.exe + .sig）
#       → [3/5] exe 双源上传（ECS + CF KV，KV 走带校验上传）
#       → [4/5] 生成 tauri-latest-test.json 双源（CF 版 url 指 CF 域名、ECS 版指裸 IP）
#       → [5/5] 回读校验（清单字段 + exe 可达）
# 纪律：先传 exe 后传清单（清单指向必须先就绪）；test 包不上 GitHub Release
#       （desktop.yml 已门控）、不动正式通道 tauri-latest.json / latest.json。
set -euo pipefail
cd "$(dirname "$0")/.."

VER="${1:?用法: build-test-desktop.sh <ver>（如 0.6.0-test.13）}"
TAG="v$VER"
REPO="humumu130/cc-deck"
ECS_HOST="root@8.133.211.170"
ECS_DIR="/opt/cc-apk"
KV_NS="d9b9bb1768324fb1b71907ca72de7aa6"
EXE_KEY="cc-deck-desktop-${VER}-x64-setup.exe"
MANIFEST_KEY="tauri-latest-test.json"
CF_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:?缺 CF_TOKEN/CLOUDFLARE_API_TOKEN}}"
# gh/git 走代理（github 直连超时；KV/ECS 不走代理）
export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
KEY="$HOME/.ssh/id_ed25519"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
TMP="$(mktemp -d /tmp/cc-deck-desktop-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "[1/5] 等 desktop.yml 的 $TAG run 完成…"
RUN_ID=""
for i in $(seq 1 120); do
  RUN_ID=$(gh run list -R "$REPO" -w desktop.yml --limit 10 --json databaseId,headBranch,status,conclusion \
    | /usr/bin/python3 -c "
import json,sys
for r in json.load(sys.stdin):
    if r['headBranch'] == '$TAG':
        print(r['databaseId'], r['status'], r['conclusion'] or '')
        break
")
  ST=$(echo "$RUN_ID" | awk '{print $2}')
  [ "$ST" = "completed" ] && break
  [ -n "$ST" ] && echo "    run $(echo "$RUN_ID" | awk '{print $1}') $ST…（30s 再查）"
  sleep 30
done
[ -n "$RUN_ID" ] || { echo "ERR: 没找到 $TAG 的 desktop.yml run——tag 推了吗？"; exit 1; }
CONCL=$(echo "$RUN_ID" | awk '{print $3}')
RUN_ID=$(echo "$RUN_ID" | awk '{print $1}')
[ "$CONCL" = "success" ] || { echo "ERR: run $RUN_ID 结论 $CONCL（非 success）——先去 Actions 排查"; exit 1; }
echo "    run $RUN_ID success"

echo "[2/5] 拉 Windows 产物（setup.exe + .sig）…"
gh run download -R "$REPO" "$RUN_ID" -n "CC-Deck-Desktop-Tauri-$TAG" -D "$TMP" || { echo "ERR: artifact 拉取失败（名字 CC-Deck-Desktop-Tauri-$TAG）"; exit 1; }
EXE=$(find "$TMP" -name '*-setup.exe' | head -1)
SIG=$(find "$TMP" -name '*-setup.exe.sig' | head -1)
[ -n "$EXE" ] && [ -n "$SIG" ] || { echo "ERR: artifact 缺 setup.exe 或 .sig（EXE=$EXE SIG=$SIG）"; exit 1; }
EXE=$(cd "$(dirname "$EXE")" && pwd)/$(basename "$EXE")
SIG=$(cd "$(dirname "$SIG")" && pwd)/$(basename "$SIG")
echo "    $(basename "$EXE") ($(stat -f%z "$EXE")B)"

echo "[3/5] exe 双源上传…"
$SCP -q "$EXE" "$ECS_HOST:$ECS_DIR/$EXE_KEY"
LOCAL_MD5=$(md5 -q "$EXE")
ECS_MD5=$($SSH "$ECS_HOST" "md5sum $ECS_DIR/$EXE_KEY" | awk '{print $1}')
[ "$LOCAL_MD5" = "$ECS_MD5" ] || { echo "ERR: ECS exe md5 不一致 local=$LOCAL_MD5 remote=$ECS_MD5"; exit 1; }
echo "    ECS md5 校验一致"
scripts/kv-put-verified.sh "$EXE" "$EXE_KEY"

echo "[4/5] 生成并上传 $MANIFEST_KEY（双源，url 各指本源）…"
SIGB64=$(base64 < "$SIG" | tr -d '\n')
PUB_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# CF 版：url 走规范路径 /download/（公司可达）；ECS 版：url 裸 IP（家庭网/流量直连）
printf '{"version":"%s","pub_date":"%s","platforms":{"windows-x86_64":{"signature":"%s","url":"https://cc.humumu.online/download/%s"}}}' \
  "$VER" "$PUB_DATE" "$SIGB64" "$EXE_KEY" > "$TMP/manifest-cf.json"
printf '{"version":"%s","pub_date":"%s","platforms":{"windows-x86_64":{"signature":"%s","url":"http://8.133.211.170:8888/%s"}}}' \
  "$VER" "$PUB_DATE" "$SIGB64" "$EXE_KEY" > "$TMP/manifest-ecs.json"
$SCP -q "$TMP/manifest-ecs.json" "$ECS_HOST:$ECS_DIR/$MANIFEST_KEY"
scripts/kv-put-verified.sh "$TMP/manifest-cf.json" "$MANIFEST_KEY"

echo "[5/5] 回读校验（清单字段 + exe 可达 + 版本序号）…"
CF_MAN=$(curl -sS --max-time 30 "https://cc.humumu.online/download/$MANIFEST_KEY")
/usr/bin/python3 -c "
import json,sys
m = json.loads('''$( echo "$CF_MAN" )''')
assert m['version'] == '$VER', 'version 不符: ' + m['version']
p = m['platforms']['windows-x86_64']
assert p['url'] == 'https://cc.humumu.online/download/$EXE_KEY', 'url 不符: ' + p['url']
assert len(p['signature']) > 100, 'signature 疑似空'
print('    CF 清单 OK: version=%s' % m['version'])
"
ECS_MAN=$($SSH "$ECS_HOST" "cat $ECS_DIR/$MANIFEST_KEY")
/usr/bin/python3 -c "
import json
m = json.loads('''$( echo "$ECS_MAN" )''')
assert m['version'] == '$VER'
assert m['platforms']['windows-x86_64']['url'] == 'http://8.133.211.170:8888/$EXE_KEY'
print('    ECS 清单 OK: version=%s' % m['version'])
"
curl -sS --max-time 20 -o /dev/null -w "    CF exe HTTP=%{http_code} len=%{size_download}\n" -r 0-1023 "https://cc.humumu.online/download/$EXE_KEY"

echo "✅ test 桌面发版完成：$VER"
echo "   旧 test 包（endpoint 已烙 test 清单 + JS 解禁的版本起）在 App 内「关于 → 检查更新」即可在线升级"
echo "   首个解禁版本前的存量 test 包仍需手动装一次（本次 $VER 即为过渡包）"
