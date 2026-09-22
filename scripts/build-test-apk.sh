#!/usr/bin/env bash
# 本地 test 包构建：版本 <base>-test.N（N 从 ECS 已有 test 包自动递增），风格对齐 snap.N
#   用法：scripts/build-test-apk.sh ["改动摘要"]
# 动作：base 取 VERSION 文件 → 基线守卫（必须 > latest.json 已发正式版）→ ECS 查最大 test.N
#       → 烙 <base>-test.N 进 build.gradle+app.json
#       → arm64 release 构建（R8 按 gradle.properties 现状）→ 推 ECS 版本化文件名 → 直链输出
# 纪律：test 包不上 GitHub Release、不进主域 latest.json/固定名 cc-deck.apk（ECS 裸 IP
# + CF KV 版本化文件名双源）；版本烙印只改工作区不提交
set -euo pipefail
cd "$(dirname "$0")/.."

# 出包互斥锁（M0 糙版，2026-09-18）：多会话并行时同时出包会在 [1/5] 撞 test.N 序号、
# 互相覆盖 ECS 文件——全局串行。macOS 无 flock(1)，用 mkdir 原子锁 + pid 探活：
# 持锁进程已死自动清残留（防死锁永久堵路），活锁则报 pid 退出
LOCK_DIR="/tmp/cc-deck-test-build.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OLD_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "ERR: 另一个 test 出包正在运行（pid $OLD_PID），等它完成后再试；确认无构建在跑可 rm -rf $LOCK_DIR" >&2
    exit 1
  fi
  echo "    清理死锁残留（pid ${OLD_PID:-unknown} 已退出）"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

NOTE="${1:-}"
BASE=$(tr -d '[:space:]' < VERSION)
ECS_HOST="root@8.133.211.170"
ECS_DIR="/opt/cc-apk"
KEY="$HOME/.ssh/id_ed25519"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

# 基线守卫（2026-09-19，0.5.2-test.17 事故防再犯）：latest.json（发版流程写入）是
# "已发正式版"的权威事实源；base 不严格大于它即拒绝出包——正式版已发布的版本号不再
# 作 test 基线（用户 2026-09-19 定的规矩）。只比 core 三段；ECS 不可达时守卫放行
#（后续 [1/5] 查序号同样会失败，不会静默错基线）
RELEASED=$($SSH "$ECS_HOST" "grep -o '\"version\":\"[^\"]*\"' $ECS_DIR/latest.json 2>/dev/null | head -1 | cut -d'\"' -f4" 2>/dev/null || true)
if [ -n "$RELEASED" ]; then
  REL_CORE=$(printf '%s' "$RELEASED" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
  BASE_CORE=$(printf '%s' "$BASE" | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+')
  if [ -n "$REL_CORE" ] && [ -n "$BASE_CORE" ]; then
    VERDICT=$(awk -v a="$BASE_CORE" -v b="$REL_CORE" 'BEGIN{split(a,x,".");split(b,y,".");for(i=1;i<=3;i++){if(x[i]+0>y[i]+0){print "newer";exit}if(x[i]+0<y[i]+0){print "older";exit}}print "equal"}')
    if [ "$VERDICT" != "newer" ]; then
      NEXT=$(awk -v b="$REL_CORE" 'BEGIN{split(b,y,".");print y[1]"."y[2]"."y[3]+1}')
      echo "ERR: 基线 ${BASE} 不高于已发正式版 ${RELEASED}（ECS latest.json）——正式版发过的版本号不再作 test 基线，先 bump VERSION 到 ${NEXT} 再出包" >&2
      exit 1
    fi
  fi
fi

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
  # KV 上传输出落日志不进 /dev/null（#154：test.28 清单上传失败真实报错被吞，
  # 只剩一句警告，排查全靠复现）——失败时 tail 带出根因
  if scripts/kv-put-verified.sh "$APK" "cc-deck-${VER}.apk" >/tmp/kv-apk-put.log 2>&1; then
    URL_CF_FIELD=",\"url_cf\":\"https://cc.humumu.online/dl/cc-deck-${VER}.apk\""
    echo "    CF 镜像: https://cc.humumu.online/dl/cc-deck-${VER}.apk"
  else
    echo "    ⚠️ CF 镜像上传失败（清单仍指 ECS），根因："
    tail -3 /tmp/kv-apk-put.log
  fi
fi
printf '{"version":"%s","url":"http://8.133.211.170:8888/cc-deck-%s.apk"%s,"size":%s,"notes":"%s"}' \
  "$VER" "$VER" "$URL_CF_FIELD" "$(stat -f%z "$APK")" "$NOTE_JSON" \
  | $SSH "$ECS_HOST" "cat > $ECS_DIR/latest-test.json"
# 清单也上 KV（2026-09-20）：ECS 裸 IP 被公司网屏蔽时清单单源会让 App 内检查更新
# 失明（拿不到清单谎报「已是最新」）——updates.ts 的 TEST_MANIFEST_URLS CF 优先读
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  $SSH "$ECS_HOST" "cat $ECS_DIR/latest-test.json" > /tmp/latest-test.json.$$
  # 同 #154：失败必须带出真实报错——清单滞留旧版 = App 检查更新拿到旧包（用户实锤）
  if scripts/kv-put-verified.sh "/tmp/latest-test.json.$$" "latest-test.json" >/tmp/kv-manifest-put.log 2>&1; then
    echo "    CF 清单: https://cc.humumu.online/dl/latest-test.json"
  else
    echo "    ⚠️ CF 清单上传失败（App 内检查更新可能拿到旧版），根因："
    tail -3 /tmp/kv-manifest-put.log
  fi
  rm -f "/tmp/latest-test.json.$$"
fi

echo "[5/5] 完成"
SIZE=$(du -h "$APK" | cut -f1)
echo "  版本: ${VER}  大小: ${SIZE}  ${NOTE}"
echo "  直链: http://8.133.211.170:8888/cc-deck-${VER}.apk（手机流量/家庭 Wi-Fi 下载）"
