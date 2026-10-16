#!/bin/bash
# disk-watchdog.sh —— W-DISKFREE 防再犯（2026-10-16）：根数据卷水位看门狗
#
# 背景：1016 晨数据卷（/System/Volumes/Data，228G）被写到 100%（剩 55Mi），
# Claude 会话工具全瘫、relay 差点写不进。本脚本定时快照水位，≥阈值时只清
# 「白名单可再生目录」并告警；绝不碰用户文档/仓库源码/git 对象。
#
# 用法：
#   scripts/disk-watchdog.sh check        # 单次检查（launchd 定时调用 / 手动）
#   scripts/disk-watchdog.sh report       # 只读报告（水位+白名单占用），零删除——盘点用
#   scripts/disk-watchdog.sh status       # 最近一次动作日志尾部
#
# 部署（由 Leader 决定执行）：
#   launchd：每 30 分钟一查（plist 样例见脚本尾注释）
#   或挂 relay 启动钩（CCR_PATROL 同款模式，见尾注）
#
# 设计口径：
#   - 水位分两档：WARN=85%（只告警不动手），ACT=90%（清白名单+告警）
#   - 白名单目录逐项注释「为什么可再生」；新增条目必须先回答这一个问题
#   - 每次动作追加日志到 ~/.cc-deck/data/disk-watchdog.log（旋转：>1MB 截半）
#   - 告警走 relay /api/notify（confirm 级——用户必须看到；relay 不在则写
#     macOS 通知中心 osascript 兜底，再兜底 echo 到日志）
#   - 清理动作幂等：目录不存在即跳过；单目录失败不中断其余项
#   - 永不动：~/Documents ~/Desktop ~/Downloads ~/Movies ~/Pictures ~/Music
#             ~/.git 任何 */node_modules（主仓依赖） ~/.colima（VM 数据盘）
#             ~/.cc-deck/org（编制库） ~/.cc-deck/data（relay 数据）

set -u

VOLUME="/System/Volumes/Data"
WARN_PCT=85
ACT_PCT=90
LOG="$HOME/.cc-deck/data/disk-watchdog.log"
RELAY_NOTIFY="http://127.0.0.1:8787/api/notify"
# 白名单：地址用 glob；「为什么可再生」逐项注释——新增条目必须先答
CLEAN_GLOBS=(
  "/private/tmp/cc-deck-w-*"        # worker worktree 沙盒：从主仓 git 创建，删后可重建（收割后即废弃；保留 48h 内新建的防误杀在用沙盒——按 mtime 过滤）
  "/private/tmp/w-*"                # worker 探针/沙盒产物目录：测试脚本输出，可再生
  "/private/tmp/claude-*/tasks/*.output"  # Claude 后台任务输出缓存：会话内可重读，过期即弃
  "$HOME/.npm/_cacache"             # npm 下载缓存：registry 可重拉（npm cache clean 等价物）
  "$HOME/Library/Caches/ms-playwright/chromium-*"  # Playwright 浏览器缓存：npx playwright install 可重装（保留一份最新版——按 mtime 保留最新 1 个）
)
# VM 快照镜像（swap/休眠）只报告不动：/System/Volumes/VM 由 macOS 管

log() { mkdir -p "$(dirname "$LOG")"; echo "[$(date '+%F %T')] $*" >> "$LOG"; }

notify() { # $1=级别 $2=正文
  local payload
  payload=$(printf '{"level":"%s","title":"disk-watchdog","body":"%s"}' "$1" "$2")
  # relay 在线则 confirm 级通知（用户必须看到）；失败回落通知中心；再失败只记日志
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 4 -X POST "$RELAY_NOTIFY" -H 'content-type: application/json' -d "$payload" >/dev/null 2>&1 && return 0
  fi
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$2\" with title \"disk-watchdog ($1)\"" >/dev/null 2>&1 && return 0
  fi
  log "notify-fallback: [$1] $2"
}

pct_of_data_volume() {
  df -k "$VOLUME" 2>/dev/null | awk 'NR==2 { printf "%d", $3 * 100 / ($3 + $4) }'
}

freed_bytes=0
# 自保护：脚本所在仓库/worktree 根绝不进清扫（FORCE 下也不许自杀）
SELF_ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)
clean_glob() { # $1=glob；worktree 类带 48h 新建保护
  local g="$1" p sz
  for p in $g; do
    [ -e "$p" ] || continue
    if [ "$(cd "$p" 2>/dev/null && pwd)" = "$SELF_ROOT" ]; then
      log "skip (self): $p"
      continue
    fi
    # 48h 内新建的 worktree/沙盒视为「可能在用」，跳过（防误杀在跑的 worker）。
    # DISK_WATCHDOG_FORCE=1 旁路：人工确认「已收割/已交付」后强制清扫（快照回执
    # 场景——夜班批已交付但残留 <48h 的散件，Leader 或当班人确认后手动放行）
    case "$p" in
      /private/tmp/cc-deck-w-*|/private/tmp/w-*)
        if [ "${DISK_WATCHDOG_FORCE:-0}" != "1" ] && [ -z "$(find "$p" -maxdepth 0 -mtime +2 2>/dev/null)" ]; then
          log "skip (age<48h, may be in use): $p"
          continue
        fi
        ;;
    esac
    sz=$(du -sk "$p" 2>/dev/null | awk '{print $1}')
    if rm -rf "$p" 2>/dev/null; then
      freed_bytes=$((freed_bytes + ${sz:-0}))
      log "cleaned: $p (${sz:-0}KB)"
    else
      log "clean-fail (skip): $p"
    fi
  done
}

# Playwright 特例：只清旧版本 chromium（保留最新一份——CI/探针在用）
clean_playwright_old() {
  local dir="$HOME/Library/Caches/ms-playwright"
  [ -d "$dir" ] || return 0
  ls -dt "$dir"/chromium-* 2>/dev/null | tail -n +2 | while read -r p; do
    local sz; sz=$(du -sk "$p" 2>/dev/null | awk '{print $1}')
    rm -rf "$p" && log "cleaned (old playwright): $p (${sz}KB)"
  done
}

rotate_log() {
  [ -f "$LOG" ] || return 0
  local sz; sz=$(stat -f%z "$LOG" 2>/dev/null || echo 0)
  if [ "$sz" -gt 1048576 ]; then
    tail -n 200 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi
}

CMD="${1:-check}"
case "$CMD" in
  report)
    echo "volume: $VOLUME  used: $(pct_of_data_volume)%"
    for g in "${CLEAN_GLOBS[@]}"; do
      for p in $g; do
        [ -e "$p" ] && echo "$(du -sh "$p" 2>/dev/null | awk '{print $1}')\t$p"
      done
    done | sort -rh
    du -sh /System/Volumes/VM 2>/dev/null | awk '{print "swap/vm (report-only): " $1}'
    exit 0
    ;;
  status)
    tail -n 30 "$LOG" 2>/dev/null || echo "(no log yet)"
    exit 0
    ;;
  check)
    ;;
  *)
    echo "usage: $0 check|report|status" >&2
    exit 2
    ;;
esac

PCT=$(pct_of_data_volume)
[ -z "$PCT" ] && { log "df-fail (volume gone?)"; exit 1; }
rotate_log

if [ "$PCT" -ge "$ACT_PCT" ]; then
  log "ACT: data volume ${PCT}% ≥ ${ACT_PCT}% —— cleaning whitelist"
  for g in "${CLEAN_GLOBS[@]}"; do
    case "$g" in
      *ms-playwright*) clean_playwright_old ;;  # 特例：保留最新版
      *) clean_glob "$g" ;;
    esac
  done
  AFTER=$(pct_of_data_volume)
  notify confirm "数据卷 ${PCT}%≥${ACT_PCT}%：已清白名单再生目录（worktree 沙盒/探针产物/npm 缓存/旧 Playwright），释放 $((freed_bytes/1024))MB，现 ${AFTER}%。详单见 disk-watchdog.log"
  log "ACT done: freed $((freed_bytes/1024))MB, ${PCT}% -> ${AFTER}%"
elif [ "$PCT" -ge "$WARN_PCT" ]; then
  log "WARN: data volume ${PCT}%"
  notify warning "数据卷 ${PCT}%（阈值 ${WARN_PCT}%）——暂未动手，白名单占用见 disk-watchdog.sh report；持续上涨将在 ${ACT_PCT}% 自动清再生目录"
fi

# ---- launchd 部署样例（Leader 批准后执行；30 分钟一查）----
# cat > ~/Library/LaunchAgents/com.ccdeck.disk-watchdog.plist <<'PLIST'
# <?xml version="1.0" encoding="UTF-8"?>
# <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
# <plist version="1.0"><dict>
#   <key>Label</key><string>com.ccdeck.disk-watchdog</string>
#   <key>ProgramArguments</key><array><string>/bin/bash</string>
#     <string>/Users/xdd/dev/cc-deck/scripts/disk-watchdog.sh</string><string>check</string></array>
#   <key>StartInterval</key><integer>1800</integer>
#   <key>RunAtLoad</key><true/>
#   <key>StandardErrorPath</key><string>/tmp/ccdeck-disk-watchdog.err</string>
# </dict></plist>
# PLIST
# launchctl load ~/Library/LaunchAgents/com.ccdeck.disk-watchdog.plist
