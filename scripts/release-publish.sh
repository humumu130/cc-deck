#!/usr/bin/env bash
# 发布推送脚本：v0.5.1 起的发布最后一步（前置：tag 已打、GitHub Release 已由 CI 创建）
# 用法：./scripts/release-publish.sh 0.5.1 "版本说明一句话"
# 动作：① 从 GitHub Release 下载产物 ② 推 ECS /opt/cc-apk/（APK+exe+双清单）
#       ③ relay /api/notify 广播发版通知给在线客户端 ④ 输出核对清单
set -euo pipefail
VER="${1:?用法: release-publish.sh <版本号> <说明>}"
NOTES="${2:-新版本已发布}"
REPO="humumu130/cc-deck"
ECS_HOST="root@8.133.211.170"
ECS_DIR="/opt/cc-apk"
KEY="$HOME/.ssh/id_ed25519"
# /api/notify 鉴权用 LAN token（relay config.ts：data/token 持久化文件）；
# bridge.json 里的是 bridgeToken（hooks 桥接令牌），拿它调 notify 必 unauthorized（v0.6.1 发版实踩）
RELAY_TOKEN="${RELAY_TOKEN:-$(tr -d '[:space:]' < "$HOME/.cc-deck/data/token" 2>/dev/null)}"
TMP="$(mktemp -d)"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

echo "⓪ 版本一致性闸门（VERSION 单一事实源）…"
node scripts/version.mjs --check

echo "① 下载 v$VER Release 产物…"
gh release download "v$VER" -R "$REPO" -D "$TMP" --clobber
APK=$(find "$TMP" \( -name "CC-Deck-v${VER}.apk" -o -name "app-arm64-v8a-release.apk" \) | head -1)
EXE=$(find "$TMP" -name '*-setup.exe' ! -name '*portable*' | head -1)
LATEST_YML=$(find "$TMP" -name 'latest.yml' | head -1)

echo "② 推 ECS（APK 直链 + 手机 latest.json + Electron exe + latest.yml）…"
# latest.json 四字段（0.6.3 起口径）：手机 OTA 需要 url（KV 版本化直链）+ size，
# 只有两字段时 App 端清单校验/进度条缺料——本地生成一份，ECS 与 KV 双通道用同一内容
APK_SIZE=$(stat -f%z "$APK")
OTA_URL="https://cc.humumu.online/dl/cc-deck-$VER.apk"
# notes 走 printf 直拼进 JSON——摘要含双引号/反斜杠会破 JSON（App 端解析失败=OTA 失明），
# 先做最小 JSON 字符串转义（双引号/反斜杠；控制字符人工摘要里不出现，不做全量）
NOTES_JSON=${NOTES//\\/\\\\}; NOTES_JSON=${NOTES_JSON//\"/\\\"}
printf '{"version":"%s","url":"%s","size":%s,"notes":"%s"}' "$VER" "$OTA_URL" "$APK_SIZE" "$NOTES_JSON" > "$TMP/latest.json"
$SCP "$APK" "$ECS_HOST:$ECS_DIR/cc-deck.apk"
[ -n "$EXE" ] && $SCP "$EXE" "$ECS_HOST:$ECS_DIR/cc-deck-desktop-setup.exe"
if [ -n "$LATEST_YML" ]; then $SCP "$LATEST_YML" "$ECS_HOST:$ECS_DIR/latest.yml"; fi
$SCP "$TMP/latest.json" "$ECS_HOST:$ECS_DIR/latest.json"

# Tauri 桌面更新链（2026-09-16 补全）：桌面 updater 读 cc.humumu.online/download/tauri-latest.json
# （KV 镜像），exe 内链必须公司可达 → setup.exe 上 KV、清单 url 指 CF 域名。
# 签名/私钥由 CI 产物自带（tauri build 生成 *-setup.exe + .sig + latest.json）
SIG=$(find "$TMP" -name '*-setup.exe.sig' | head -1)
if [ -n "$EXE" ] && [ -n "$SIG" ] && [ -n "${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" ]; then
  SIGB64=$(base64 < "$SIG" | tr -d '\n')
  EXEURL="https://cc.humumu.online/dl/cc-deck-$VER-setup.exe"
  printf '{"version":"%s","pub_date":"%s","platforms":{"windows-x86_64":{"signature":"%s","url":"%s"}}}' \
    "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SIGB64" "$EXEURL" > "$TMP/tauri-latest-gen.json"
  $SCP "$EXE" "$ECS_HOST:$ECS_DIR/cc-deck-$VER-setup.exe"
  (cd cloudflare && CLOUDFLARE_API_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" npx wrangler kv key put "cc-deck-$VER-setup.exe" --path "$EXE" --namespace-id d9b9bb1768324fb1b71907ca72de7aa6 --remote >/dev/null)
  (cd cloudflare && CLOUDFLARE_API_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" npx wrangler kv key put "tauri-latest.json" --path "$TMP/tauri-latest-gen.json" --namespace-id d9b9bb1768324fb1b71907ca72de7aa6 --remote >/dev/null)
  echo "   桌面更新链已推（KV manifest + exe，公司可达）"
else
  echo "   ⚠️ 缺 sig/latest.json/CF_TOKEN——桌面更新链未更新（CI 产物不全或未配 token）"
fi

# #239（2026-10-03 主页审计实锤）：KV 固定名同步——Worker /dl/ 对 cc-deck-* 前缀是
# 纯 KV 直出（KV miss 直接 404，不回落 ECS：ECS 回源被阿里云对 CF 境外出口 403 挡、
# 公司网又屏蔽裸 IP，KV 是唯一全通路径）。此前发版只更 ECS 不更 KV → KV 旧包永久
# 遮蔽新包（0.6.3 实锤：主页 Windows 直链发的还是 0.5.x 时代旧 exe、安卓固定名同患）。
# 四键齐上：latest.json（手机 OTA 清单）+ cc-deck.apk（主页安卓固定名）+
# cc-deck-$VER.apk（版本化，OTA url 指向它）+ cc-deck-desktop-setup.exe（主页 Windows 固定名）
echo "③ KV 同步（Worker /dl/ 唯一货源：OTA 清单 + 安卓双键 + Windows 固定名）…"
if [ -n "${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" ]; then
  $SCP "$APK" "$ECS_HOST:$ECS_DIR/cc-deck-$VER.apk"
  ./scripts/kv-put-verified.sh "$TMP/latest.json" "latest.json"
  ./scripts/kv-put-verified.sh "$APK" "cc-deck.apk"
  ./scripts/kv-put-verified.sh "$APK" "cc-deck-$VER.apk"
  [ -n "$EXE" ] && ./scripts/kv-put-verified.sh "$EXE" "cc-deck-desktop-setup.exe"
else
  echo "   ⚠️ 缺 CF_TOKEN/CLOUDFLARE_API_TOKEN——KV 未同步，主页直链/OTA 将滞留旧版（#239）"
fi

echo "④ relay 广播发版通知给在线客户端…"
curl -sS -X POST "http://127.0.0.1:8787/api/notify?token=$RELAY_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"done\":[\"🎉 v$VER 发布：$NOTES\"]}" | head -c 60; echo

echo "⑤ 核对："
curl -sS -m 8 "http://8.133.211.170:8888/latest.json" | head -c 120; echo
curl -sS -m 8 -o /dev/null -w "APK 直链 HTTP=%{http_code}\n" -r 0-99 "http://8.133.211.170:8888/cc-deck.apk"
curl -sS -m 15 -o /dev/null -w "KV 主页安卓固定名 HTTP=%{http_code} %{size_download}B（Range）\n" -r 0-99 "https://cc-deck.humumu.online/dl/cc-deck.apk"
curl -sS -m 15 -I "https://cc-deck.humumu.online/download/cc-deck-desktop-setup.exe" | grep -i '^HTTP\|^content-length'

# #239：主页版本号随发版上线——version.mjs --write 只改仓库文件不会自动生效，
# 静态资产必须 wrangler deploy（0.6.2/0.6.3 两版徽章停在 v0.6.1 的根因）。
# deploy 同时带 worker.ts 上线：发版分支基于 dev，worker 代码天然同步，无 #220 分叉风险
# 安全批部署守卫（2026-10-03 事故复盘）：上午修主页徽章的 deploy 从缺安全批的分支上线，
# 把生产 worker 抹回无加固版本（#28/#29 全部失守数小时）——「本地=origin/dev」不能保证
# deploy 安全（生产实际部署源曾是含安全批的 m2 分支）。deploy 是整树上线：树上没有 =
# 线上被抹掉。守卫拦「树里没有」，线上复核拦「部署的不是这棵树」，双保险
if ! grep -q 'SEC_HEADERS' cloudflare/src/worker.ts || ! grep -q 'rlDevOfRk' cloudflare/src/worker.ts; then
  echo "❌ 拒部：当前树 cloudflare/src/worker.ts 缺安全批特征（SEC_HEADERS / rlDevOfRk）——"
  echo "   wrangler deploy 整树上线会把生产安全批抹掉（2026-10-03 事故复盘）。先合并安全批再发版"
  exit 1
fi
echo "⑥ 主页版本上线（wrangler deploy 静态资产）…"
if [ -n "${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" ]; then
  (cd cloudflare && CLOUDFLARE_API_TOKEN="${CF_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}" npx wrangler deploy 2>&1 | tail -3)
  # 部署后线上复核：生产实际拿到安全头才算闭环（传播秒级，直查即可）
  sleep 3
  if curl -sIm 15 "https://cc-deck.humumu.online/" | grep -qi 'x-frame-options'; then
    echo "   ✅ 线上安全头复核通过"
  else
    echo "   ⚠️ 线上未见安全头——部署可能未按预期生效，人工核查 wrangler.toml/部署目录"
  fi
else
  echo "   ⚠️ 缺 CF_TOKEN——主页未部署，版本徽章将停更（#239）"
fi

echo "✅ v$VER 发布推送完成（手机 24h 内提示 / 在线设备即时通知 / Tauri 更新链随 Release latest.json 生效）"
echo "清理临时目录: $TMP"
