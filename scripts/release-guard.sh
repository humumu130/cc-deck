#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:?usage: release-guard.sh <version>}"
FAIL=0
node scripts/version.mjs --check >/dev/null 2>&1 || { echo "❌ 版本落点漂移"; node scripts/version.mjs --check; exit 1; }
echo "✅ 版本一致 ($VER)"
# 烙印检查（通道感知，2026-10-07 ⑥d Leader 裁定）：0.7.0 起三线统一，预发通道版本
# （-test.N/-snap.N）也走 VERSION 单一事实源出包——原一刀切「expo 不得含 test.N」与
# 预发版本互斥。闸门本意=防正式版被预发残留污染，不是禁预发本身：
#   预发通道：$VER 须与 VERSION 文件一致（防传错参）；expo 两文件提取的全部
#             (test|snap).N 段须至少命中一处且唯一值全等于 $VER 预发段
#             （防 test.2 源里残留 test.1）
#   正式版：原检查原样保留（expo 不得含任何 test.N/snap.N）
if [[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+-(test|snap)\. ]]; then
  VERSION_VAL="$(tr -d '[:space:]' < VERSION 2>/dev/null || true)"
  if [ "$VERSION_VAL" != "$VER" ]; then
    echo "❌ 预发通道版本传参错误：$VER ≠ VERSION 文件值（${VERSION_VAL:-空}）"; exit 1
  fi
  PRE="${VER#*-}"
  # grep -o 逐段提取（天然免疫空白/多值场景）；set -e 下无命中须 || true 兜底
  SEGS="$(grep -hoE '(test|snap)\.[0-9]+' expo-app/android/app/build.gradle expo-app/app.json 2>/dev/null | sort -u || true)"
  if [ -z "$SEGS" ]; then
    echo "❌ 预发通道烙印缺失：expo 两文件未命中任何 ${PRE}（版本未同步？）"; exit 1
  fi
  BAD=""
  while IFS= read -r seg; do
    [ -n "$seg" ] || continue
    if [ "$seg" != "$PRE" ]; then echo "❌ 预发通道烙印污染：expo 残留 ${seg} ≠ ${PRE}"; BAD=1; fi
  done <<< "$SEGS"
  if [ "$BAD" = "1" ]; then exit 1; fi
  echo "✅ 预发通道烙印一致（expo 两文件预发段 = ${PRE}）"
else
  grep -qE 'test\.[0-9]|snap\.[0-9]' expo-app/android/app/build.gradle expo-app/app.json 2>/dev/null && { echo "❌ 烙印污染"; exit 1; }
  echo "✅ 无烙印"
fi
./scripts/check-bundle-sync.sh >/dev/null 2>&1 || { echo "❌ bundle 同步失败"; exit 1; }
echo "✅ bundle 同步"
# tsc 闸门（2026-09-17 colorOf/isIdleCard 未定义引用 → release 渲染即闪退事故的防再犯：
# 这类错 tsc 一秒逮住，但 release 构建不跑 tsc 就直接出包）
(cd expo-app && ./node_modules/.bin/tsc --noEmit >/dev/null 2>&1) || { echo "❌ expo tsc 未过（未定义引用/类型错误）"; (cd expo-app && ./node_modules/.bin/tsc --noEmit 2>&1 | head -5); exit 1; }
echo "✅ expo tsc 通过"
# web-console 闸门：内联脚本语法 + nacl.js/qr.js 同目录在（桌面 UI 的全部家当）
python3 - <<'PYEOF' || { echo "❌ web-console 闸门未过"; exit 1; }
import re, subprocess, sys, os
html = open('web-console/index.html', encoding='utf-8').read()
scripts = re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>', html, re.S)
for i, s in enumerate(scripts):
    p = f'/tmp/guard-wc-{i}.js'
    open(p, 'w', encoding='utf-8').write(s)
    r = subprocess.run(['node', '--check', p], capture_output=True)
    if r.returncode != 0:
        print(f'block {i}: ' + r.stderr.decode()[:200]); sys.exit(1)
for f in ('nacl.js', 'qr.js'):
    if not os.path.exists(f'web-console/{f}'):
        print(f'missing web-console/{f}'); sys.exit(1)
PYEOF
echo "✅ web-console 语法与配套资源"
[ -z "$(git status --porcelain)" ] || { echo "❌ 工作区不干净"; exit 1; }
echo "✅ 工作区干净"
(cd relay && npm run test:bridge >/dev/null 2>&1) || { echo "❌ bridge 测试失败"; exit 1; }
echo "✅ bridge 测试通过"
echo "✅ 发版守卫全部通过"
