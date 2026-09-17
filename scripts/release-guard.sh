#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:?usage: release-guard.sh <version>}"
FAIL=0
node scripts/version.mjs --check >/dev/null 2>&1 || { echo "❌ 版本落点漂移"; node scripts/version.mjs --check; exit 1; }
echo "✅ 版本一致 ($VER)"
grep -qE 'test\.[0-9]|snap\.[0-9]' expo-app/android/app/build.gradle expo-app/app.json 2>/dev/null && { echo "❌ 烙印污染"; exit 1; }
echo "✅ 无烙印"
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
