#!/usr/bin/env bash
# 本地 test 包构建：版本 <base>-test.N（N 从 ECS 已有 test 包自动递增），风格对齐 snap.N
#   用法：scripts/build-test-apk.sh ["改动摘要"]
# 动作：base 取 VERSION 文件 → ECS 查最大 test.N → 烙 <base>-test.N 进 build.gradle+app.json
#       → arm64 release 构建（R8 按 gradle.properties 现状）→ 推 ECS 版本化文件名 → 直链输出
# 纪律：test 包只走 ECS 裸 IP 路径，永不进 CF 主域；版本烙印只改工作区不提交
set -euo pipefail
cd "$(dirname "$0")/.."

NOTE="${1:-}"
BASE=$(tr -d '[:space:]' < VERSION)
ECS_HOST="root@8.133.211.170"
ECS_DIR="/opt/cc-apk"
KEY="$HOME/.ssh/id_ed25519"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

echo "[1/5] base=$BASE, ECS 查已有 test 序号"
EXISTING=$($SSH "ls $ECS_DIR 2>/dev/null | grep -E 'cc-deck-${BASE}-test\.[0-9]+\.apk' | grep -oE 'test\.[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1" 2>/dev/null || true)
N=$(( ${EXISTING:-0} + 1 ))
VER="${BASE}-test.${N}"
echo "    → ${VER}"

echo "[2/5] 烙版本（build.gradle + app.json，工作区不提交）"
sed -i '' "s/versionName \"[^\"]*\"/versionName \"${VER}\"/" expo-app/android/app/build.gradle
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VER}\"/" expo-app/app.json
grep -q "versionName \"${VER}\"" expo-app/android/app/build.gradle || { echo "ERR: versionName stamp failed"; exit 1; }

echo "[3/5] 构建 arm64 release APK"
(cd expo-app/android && JAVA_HOME=${JAVA_HOME:-/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home} \
  ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --console=plain -q)
APK="expo-app/android/app/build/outputs/apk/release/app-arm64-v8a-release.apk"
[ -f "$APK" ] || { echo "ERR: APK not found"; exit 1; }
AAPT=$(ls "$HOME/Library/Android/sdk/build-tools/"*/aapt 2>/dev/null | tail -1)
[ -n "$AAPT" ] && "$AAPT" dump badging "$APK" 2>/dev/null | head -1 | grep -o "versionName='[^']*'"

echo "[4/5] 推 ECS 版本化文件名"
$SCP -q "$APK" "$ECS_HOST:$ECS_DIR/cc-deck-${VER}.apk"
# 清掉旧固定名 test 包（今天之前的历史遗留，避免"分不清是哪个"的同类问题）
$SSH "rm -f $ECS_DIR/cc-deck-${BASE}-test.apk" 2>/dev/null || true

echo "[5/5] 完成"
SIZE=$(du -h "$APK" | cut -f1)
echo "  版本: ${VER}  大小: ${SIZE}  ${NOTE}"
echo "  直链: http://8.133.211.170:8888/cc-deck-${VER}.apk（手机流量/家庭 Wi-Fi 下载）"
