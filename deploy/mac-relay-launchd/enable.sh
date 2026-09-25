#!/bin/zsh
# #76 relay 系统服务化：把 relay 注册为 launchd LaunchAgent（开机自启 + 崩溃自拉起）。
# 安全边界：
#   - 绝不杀既有 relay（生产壳的子进程受保护）——端口被占且非本服务时直接退出给指引；
#   - 生成的 plist 用启用当时的绝对路径（node / app bundle），不做运行时猜测。
# 用法：./enable.sh          正常启用（端口被占会拒绝并给过渡指引）
#       FORCE=1 ./enable.sh  强制注册（容忍端口暂被占——适合「壳退出后服务随时接管」预埋）
set -euo pipefail

LABEL="online.humumu.ccdeck.relay"
UID_N=$(id -u)
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PORT="${CCR_PORT:-8787}"
DATA_DIR="${CCR_DATA_DIR:-$HOME/.cc-deck/data}"
LOG="$DATA_DIR/relay-service.log"

NODE=$(command -v node) || { echo "✗ node 不在 PATH——launchd 环境极简，需启用方解析绝对路径"; exit 1; }
APP_RELAY="${APP_RELAY:-/Applications/CC Deck.app/Contents/Resources/resources/relay.mjs}"
[ -f "$APP_RELAY" ] || { echo "✗ 找不到 $APP_RELAY（CC Deck 装在别处？APP_RELAY=... ./enable.sh 覆盖）"; exit 1; }
INJECT_CS="${APP_RELAY%resources/*}resources/bin/inject.cs"

# 过渡闸门：端口已有 relay 在服务（壳子进程/手动实例）时不硬上——
# 硬上=launchd 实例 EADDRINUSE 崩溃循环。先退壳再启用，或 FORCE=1 预埋。
if [[ "${FORCE:-}" != "1" ]] && lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✗ 端口 $PORT 已有 relay 在服务（桌面壳子进程或手动实例），启用会撞端口。"
  echo "  过渡顺序：① 退出 CC Deck 桌面端（壳会带走内嵌 relay）② 再跑本脚本。"
  echo "  或 FORCE=1 ./enable.sh 只注册不抢占——等壳下次退出后 KeepAlive 自动接管。"
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR"

INJECT_CS_ENV=""
if [ -f "$INJECT_CS" ]; then
  INJECT_CS_ENV="    <key>CCR_INJECT_CS</key>
    <string>$INJECT_CS</string>
"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_RELAY</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CCR_PORT</key>
    <string>$PORT</string>
    <key>CCR_DATA_DIR</key>
    <string>$DATA_DIR</string>
$INJECT_CS_ENV    <key>CCR_NOHOOK_IDLE_MS</key>
    <string>60000</string>
    <key>PATH</key>
    <string>$HOME/node/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF

echo "→ plist 已生成：$PLIST"
# 幂等：先摘旧注册再挂新
launchctl bootout "gui/$UID_N/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_N" "$PLIST"
launchctl enable "gui/$UID_N/$LABEL"

if [[ "${FORCE:-}" != "1" ]]; then
  launchctl kickstart -k "gui/$UID_N/$LABEL"
  sleep 2
  if lsof -ti ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "✓ relay 服务已上线（端口 $PORT），日志：$LOG"
  else
    echo "… 端口 $PORT 尚未就绪，看日志：tail -50 $LOG"
  fi
else
  echo "✓ 已预埋注册（FORCE）：端口空出后 KeepAlive 自动拉起"
fi
echo "  热部署重启：launchctl kickstart -k gui/$UID_N/$LABEL"
echo "  停用：      ./disable.sh"
