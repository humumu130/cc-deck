#!/usr/bin/env bash
# wrangler 远端操作双路网络封装（fix/wrangler-toolchain，2026-10-30 实测矩阵定案）
#
# 为什么存在（三根因，均 2026-10-30 仪器化实测）：
#   1. 双间歇源叠加：「api.cloudflare.com 直连」与「FlClash 7890 代理」都是时通时断
#      （直连=GFW 间歇干扰，2026-09-22 曾被墙；代理=FlClash 进程在而 7890 不监听/
#      系统代理开关漂移，1029 当天 fetch failed 与 1030 会话中均复现）。
#      任何单一路径必然间歇失败 → 直连优先、代理回落的双路才稳。
#   2. 「大写 HTTPS_PROXY 不通」旧结论过时：wrangler 4.154.0（undici 7.30.1）大小写
#      proxy env 都认且都走代理（假代理抓 CONNECT 实测：小写/大写/都设三姿势均
#      8000+ 条 CONNECT api.cloudflare.com，对照组 0 条）。旧「必须小写」是代理死
#      窗口期的误归因。设了 proxy env 而代理死 = fetch failed 且 exit 1——所以
#      本封装默认先清空 proxy env 直连，代理只做回落。
#   3. wrangler 4.x kv 子命令默认 local（miniflare .wrangler/state）：`kv key list`
#      不带 --remote **静默返回 []**（exit 0），看着像「成功拿到空列表」——1029
#      云回流批「KV 0 键误诊」的真机制。本封装对未指定 --remote/--local 的 kv
#      命令打醒目警告（不改参数、不猜意图；--local 是本地开发正当需求）。
#
# 用法（在需要 wrangler.toml 上下文的命令——secret/deploy——下先 cd cloudflare/）：
#   cd cloudflare && ../scripts/wrangler-remote.sh deploy
#   cd cloudflare && ../scripts/wrangler-remote.sh secret list
#   scripts/wrangler-remote.sh kv key list --namespace-id <ns> --remote   # kv 免 toml
#   scripts/wrangler-remote.sh kv key put <k> <v> --namespace-id <ns> --remote
# 本脚本不切 cwd：wrangler 按 cwd 找 wrangler.toml，切走会丢 secret/deploy 上下文。
#
# 相关：scripts/kv-put-verified.sh 是「wrangler --remote 直连 + curl REST 代理回落」
# 的等价双路（含 md5 回读校验），上传链继续走它；本脚本管其余日常远端操作。
set -uo pipefail   # 不用 -e：第一路失败要走回落分支而非直接退出

WRANGLER_BIN="$HOME/.npm/_npx/32026684e21afda6/node_modules/.bin/wrangler"
CC_CF_PROXY="${CC_CF_PROXY:-http://127.0.0.1:7890}"   # 与 kv-put-verified.sh 同名变量

if [ -x "$WRANGLER_BIN" ]; then
  WR=("$WRANGLER_BIN")
else
  echo "⚠️  固定 wrangler bin 不在（${WRANGLER_BIN}，npx 缓存被清？）——回落 npx 现解析（需网络）" >&2
  WR=(npx --yes wrangler)
fi
[ "$#" -gt 0 ] || { echo "用法: scripts/wrangler-remote.sh <wrangler 子命令及参数…>" >&2; exit 2; }

# kv 防呆：未指定 --remote/--local 时警告（默认 local，list 静默 [] 是事故根因）
if [ "$1" = "kv" ]; then
  mode_seen=0
  for a in "$@"; do case "$a" in --remote|--local) mode_seen=1 ;; esac; done
  if [ "$mode_seen" -eq 0 ]; then
    echo "⚠️  kv 子命令未带 --remote/--local：wrangler 4.x 默认 local（miniflare），list 会静默返回 []——查/写生产 KV 必须显式 --remote" >&2
  fi
fi

# 网络失败特征（wrangler 的 fetch failed 包装文案 + undici/socket 错误码）：
# 命中才回落代理；参数错/权限错等业务失败不双跑（重跑也只是双份错误输出）
NET_FAIL_RE='fetch (request )?failed|connectivity issue|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EAI_AGAIN|UND_ERR_CONNECT|socket hang up'

LOG1="$(mktemp /tmp/wr-remote.XXXXXX)"
trap 'rm -f "$LOG1"' EXIT

# —— 路径①直连：清空全部大小写 proxy env（当前直连可达性最好且无代理单点）——
if env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
     "${WR[@]}" "$@" > >(tee "$LOG1") 2>&1; then
  exit 0
fi
RC1=$?
if ! grep -qiE "$NET_FAIL_RE" "$LOG1"; then
  # 业务失败（参数/权限/配置类）——原码退出，不重跑
  exit "$RC1"
fi

echo "—— 直连失败（疑似网络窗口），回落本地代理 ${CC_CF_PROXY} 重试 ——" >&2

# —— 路径②代理：小写 https_proxy（4.154.0 大小写都认，小写是既有惯例）——
if env https_proxy="$CC_CF_PROXY" "${WR[@]}" "$@" ; then
  exit 0
fi
RC2=$?

{
  echo "❌ wrangler 双路均失败（直连 + 代理 ${CC_CF_PROXY}）"
  echo "   诊断：①代理状态: lsof -nP -iTCP:7890 -sTCP:LISTEN（空=FlClash 未监听，看 FlClash 开关/重启）"
  echo "        ②直连探测: curl -s --noproxy '*' -o /dev/null -w '%{http_code}\\n' https://api.cloudflare.com/client/v4/ (000=直连断)"
  echo "        ③等价兜底: CF REST API + curl（kv-put-verified.sh 同款，token 走 CLOUDFLARE_API_TOKEN）"
} >&2
exit "$RC2"
