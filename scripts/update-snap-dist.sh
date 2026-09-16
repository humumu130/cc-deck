#!/usr/bin/env bash
# snap 分发更新：CI 绿后把 <tag> 产物推到 ECS + CF KV，一次做完
#   用法：scripts/update-snap-dist.sh v0.5.1-snap.7
# 动作：
#   ① GitHub Actions 下载该 tag 的 desktop(exe) + android(APK arm64) 产物
#   ② ECS：版本化文件名 + 刷新 -latest 稳定名（老链接兼容）
#   ③ KV：exe 直出对象（公司唯一全通路径）+ metadata.filename 版本化下载名
#        + snap-latest-version 指针（APK 302 目标用）
#   ④ 双通道路由实测（ECS 206 / CF 200 + 文件名头）
# 前置：gh 已登录；scp 免密（~/.ssh/id_ed25519）；CLOUDFLARE_API_TOKEN 已导出或传 CF_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?usage: update-snap-dist.sh <tag>}"
VER="${TAG#v}"
ECS_HOST="root@8.133.211.170"
ECS_DIR="/opt/cc-apk"
KEY="$HOME/.ssh/id_ed25519"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
KV_NS="d9b9bb1768324fb1b71907ca72de7aa6"
CF_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"
[ -n "$CF_TOKEN" ] || { echo "ERR: missing CF_TOKEN/CLOUDFLARE_API_TOKEN"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[1/4] download CI artifacts for ${TAG}"
# 取该 tag 对应 commit 触发的、已成功的 run（android/desktop 各最新一条）
SHA=$(git rev-parse "$TAG^{commit}")
DESKTOP_RUN=$(gh run list --workflow=desktop.yml --commit="$SHA" --status=success -L 1 --json databaseId -q '.[0].databaseId')
ANDROID_RUN=$(gh run list --workflow=android.yml --commit="$SHA" --status=success -L 1 --json databaseId -q '.[0].databaseId')
[ -n "$DESKTOP_RUN" ] && [ -n "$ANDROID_RUN" ] || { echo "ERR: no successful run for ${TAG} (desktop=${DESKTOP_RUN} android=${ANDROID_RUN})"; exit 1; }
gh api "repos/humumu130/cc-deck/actions/runs/$DESKTOP_RUN/artifacts" -q '.artifacts[0].id' | xargs -I{} gh api "repos/humumu130/cc-deck/actions/artifacts/{}/zip" > "$TMP/desktop.zip"
gh api "repos/humumu130/cc-deck/actions/runs/$ANDROID_RUN/artifacts" -q '.artifacts[] | select(.name | test("CC-Deck-v")) | .id' | head -1 | xargs -I{} gh api "repos/humumu130/cc-deck/actions/artifacts/{}/zip" > "$TMP/android.zip"
unzip -oq "$TMP/desktop.zip" -d "$TMP/desktop"
unzip -oq "$TMP/android.zip" -d "$TMP/android"
EXE=$(find "$TMP/desktop" -name '*-setup.exe' | head -1)
APK=$(find "$TMP/android" -name 'app-arm64-v8a-release.apk' | head -1)
[ -n "$EXE" ] && [ -n "$APK" ] || { echo "ERR: missing artifacts exe=${EXE} apk=${APK}"; exit 1; }
echo "   exe=$(du -h "$EXE" | cut -f1)  apk=$(du -h "$APK" | cut -f1)"

echo "[2/4] ECS: versioned + refresh stable names"
$SCP "$EXE" "$ECS_HOST:$ECS_DIR/cc-deck-$VER-setup.exe"
$SCP "$EXE" "$ECS_HOST:$ECS_DIR/cc-deck-snap-latest-setup.exe"
$SCP "$APK" "$ECS_HOST:$ECS_DIR/cc-deck-$VER.apk"
$SCP "$APK" "$ECS_HOST:$ECS_DIR/cc-deck-snap-latest.apk"

echo "[3/4] CF KV: exe object + version pointer"
(cd cloudflare && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler kv key put "cc-deck-snap-latest-setup.exe" --path "$EXE" --namespace-id "$KV_NS" --remote --metadata "{\"filename\":\"CC Deck_${VER}_x64-setup.exe\"}" >/dev/null)
(cd cloudflare && CLOUDFLARE_API_TOKEN="$CF_TOKEN" npx wrangler kv key put "snap-latest-version" "$VER" --namespace-id "$KV_NS" --remote >/dev/null)

echo "[4/4] verify routes"
curl -sS -m 8 -o /dev/null -w "   ECS exe   HTTP=%{http_code}\n" -r 0-0 "http://8.133.211.170:8888/cc-deck-$VER-setup.exe"
curl -sS -m 8 -o /dev/null -w "   ECS apk   HTTP=%{http_code}\n" -r 0-0 "http://8.133.211.170:8888/cc-deck-$VER.apk"
CF_FN=$(curl -sS -m 20 -o /dev/null -D - "https://cc.humumu.online/dl/cc-deck-snap-latest-setup.exe" | tr -d '\r' | grep -i content-disposition | head -1)
echo "   CF  exe   $CF_FN"
CF_APK_LOC=$(curl -sS -m 8 -o /dev/null -D - "https://cc.humumu.online/dl/cc-deck-snap-latest.apk" | tr -d '\r' | grep -i '^location' | head -1)
echo "   CF  apk   $CF_APK_LOC"

echo "OK snap dist updated: ${VER}"
echo "   桌面（公司可达）：https://cc.humumu.online/dl/cc-deck-snap-latest-setup.exe"
echo "   手机：            https://cc.humumu.online/dl/cc-deck-snap-latest.apk"
