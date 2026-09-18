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
EXISTING=$($SSH "$ECS_HOST" "ls $ECS_DIR 2>/dev/null | grep -E 'cc-deck-${BASE}-test\.[0-9]+\.apk' | grep -oE 'test\.[0-9]+' | grep -oE '[0-9]+' | sort -n | tail -1" 2>/dev/null || true)
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
unzip -t "$APK" >/dev/null 2>&1 || { echo "ERR: APK zip 损坏，禁止出包"; exit 1; }
AAPT=$(ls "$HOME/Library/Android/sdk/build-tools/"*/aapt 2>/dev/null | tail -1)
[ -n "$AAPT" ] && "$AAPT" dump badging "$APK" 2>/dev/null | head -1 | grep -o "versionName='[^']*'"

echo "[4/5] 推 ECS 版本化文件名"
$SCP -q "$APK" "$ECS_HOST:$ECS_DIR/cc-deck-${VER}.apk"
# 上传完整性校验（2026-09-17 KV 坏包事故防再犯：远端 md5 必须与本地一致）
REMOTE_MD5=$($SSH "$ECS_HOST" "md5sum $ECS_DIR/cc-deck-${VER}.apk | cut -d' ' -f1" 2>/dev/null)
[ "$REMOTE_MD5" = "$(md5 -q "$APK")" ] || { echo "ERR: ECS 远端 md5 不一致（local=$(md5 -q "$APK") remote=$REMOTE_MD5）"; exit 1; }
echo "    ECS md5 校验一致"
# 清掉旧固定名 test 包（今天之前的历史遗留，避免"分不清是哪个"的同类问题）
$SSH "$ECS_HOST" "rm -f $ECS_DIR/cc-deck-${BASE}-test.apk" 2>/dev/null || true

# test 通道清单（2026-09-18 通道隔离）：test 设备应用内检查更新读这份（updates.ts
# TEST_MANIFEST_URL），随出包自动指向最新 test.N 版本化直链；主清单 latest.json 永不
# 写 test 版本（release/snap 设备看不到 test 包）。url 必须是 ECS 版本化文件名前缀
# （app 侧白名单校验），notes 进更新弹窗特性摘要。
NOTE_JSON=$(printf '%s' "$NOTE" | sed 's/"/\\"/g')
[ -n "$NOTE_JSON" ] || NOTE_JSON="测试通道构建"
# CF 镜像（2026-09-18 晚，可选）：配了 CLOUDFLARE_API_TOKEN 时 APK 也上 KV 版本化
# 文件名，清单加 url_cf——公司网屏蔽 ECS 裸 IP，新客户端（≥test.16）优先 CF 也能
# 在线升 test 包；url 字段保持 ECS 供旧客户端（≤test.15）兼容。无 token 静默跳过。
URL_CF_FIELD=""
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if scripts/kv-put-verified.sh "$APK" "cc-deck-${VER}.apk" >/dev/null 2>&1; then
    URL_CF_FIELD=",\"url_cf\":\"https://cc.humumu.online/dl/cc-deck-${VER}.apk\""
    echo "    CF 镜像: https://cc.humumu.online/dl/cc-deck-${VER}.apk"
  else
    echo "    ⚠️ CF 镜像上传失败（清单仍指 ECS）"
  fi
fi
printf '{"version":"%s","url":"http://8.133.211.170:8888/cc-deck-%s.apk"%s,"size":%s,"notes":"%s"}' \
  "$VER" "$VER" "$URL_CF_FIELD" "$(stat -f%z "$APK")" "$NOTE_JSON" \
  | $SSH "$ECS_HOST" "cat > $ECS_DIR/latest-test.json"

echo "[5/5] 完成"
SIZE=$(du -h "$APK" | cut -f1)
echo "  版本: ${VER}  大小: ${SIZE}  ${NOTE}"
echo "  直链: http://8.133.211.170:8888/cc-deck-${VER}.apk（手机流量/家庭 Wi-Fi 下载）"
