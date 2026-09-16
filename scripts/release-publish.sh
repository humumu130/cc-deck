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
RELAY_TOKEN="${RELAY_TOKEN:-$(grep -oE '"token":"[a-f0-9]+"' "$HOME/.cc-deck/data/bridge.json" | grep -oE '[a-f0-9]+' | head -1)}"
TMP="$(mktemp -d)"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"

echo "① 下载 v$VER Release 产物…"
gh release download "v$VER" -R "$REPO" -D "$TMP" --clobber
APK=$(find "$TMP" \( -name "CC-Deck-v${VER}.apk" -o -name "app-arm64-v8a-release.apk" \) | head -1)
EXE=$(find "$TMP" -name '*-setup.exe' ! -name '*portable*' | head -1)
LATEST_YML=$(find "$TMP" -name 'latest.yml' | head -1)

echo "② 推 ECS（APK 直链 + 手机 latest.json + Electron exe + latest.yml）…"
$SCP "$APK" "$ECS_HOST:$ECS_DIR/cc-deck.apk"
[ -n "$EXE" ] && $SCP "$EXE" "$ECS_HOST:$ECS_DIR/cc-deck-desktop-setup.exe"
if [ -n "$LATEST_YML" ]; then $SCP "$LATEST_YML" "$ECS_HOST:$ECS_DIR/latest.yml"; fi
printf '{"version":"%s","notes":"%s"}' "$VER" "$NOTES" | $SSH $ECS_HOST "cat > $ECS_DIR/latest.json"

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

echo "③ relay 广播发版通知给在线客户端…"
curl -sS -X POST "http://127.0.0.1:8787/api/notify?token=$RELAY_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"done\":[\"🎉 v$VER 发布：$NOTES\"]}" | head -c 60; echo

echo "④ 核对："
curl -sS -m 8 "http://8.133.211.170:8888/latest.json" | head -c 120; echo
curl -sS -m 8 -o /dev/null -w "APK 直链 HTTP=%{http_code}\n" -r 0-99 "http://8.133.211.170:8888/cc-deck.apk"
echo "✅ v$VER 发布推送完成（手机 24h 内提示 / 在线设备即时通知 / Tauri 更新链随 Release latest.json 生效）"
echo "清理临时目录: $TMP"
