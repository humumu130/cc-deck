#!/usr/bin/env node
// bundle 重建对比（2026-10-10 A2，审查 P1-3 防再犯）：用与 build-plugin.mjs 完全
// 相同的 esbuild 参数（单源见 bundle-options.mjs）从当前 relay/src 重建 bundle 到
// 临时目录，stdout 打印该目录路径。调用方 scripts/check-bundle-sync.sh 拿它与
// cc-plugins 部署位 bundle 比 SHA-256——「部署的 bundle == 当前源码的构建产物」
// 就此可验。此前守卫只锁 B1/B2 两份副本一致 + 探针串，锁不住「bundle 是别处
// 源码状态所出」：test.7-nova tag 的 bundle 即为合并后工作树所出、与 tag 源码
// 不符，从 tag 拉热修分支重打包会静默回退旧 relay。esbuild 确定性已由审查实证
// （同参重建与部署位逐字节一致，/tmp/waudit-contract/rebuild.mjs），且 bundleOptions
// 已钉 absWorkingDir——从任何 cwd 调用本脚本产物同字节（2026-10-10 实测三方同 SHA）。
// 注意：本脚本须放 relay/scripts/ 下（esbuild 从 relay/node_modules 解析，与
// build-plugin 同源同版本——换 esbuild 版本可能改变产物字节，重建闸会如实报红，
// 此时重跑 build-plugin.mjs 刷新部署位即可）。
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleOptions } from "./bundle-options.mjs";

const outDir = mkdtempSync(join(tmpdir(), "ccdeck-rebuild."));
try {
  // logLevel 只影响日志不影响产物字节；静默以免污染调用方要解析的 stdout
  await build({ ...bundleOptions(join(outDir, "relay.mjs")), logLevel: "silent" });
} catch (err) {
  rmSync(outDir, { recursive: true, force: true });
  throw err;
}
console.log(outDir);
