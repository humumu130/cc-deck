// relay bundle 的 esbuild 参数单源（2026-10-10 A2 bundle 可复现守卫）：
// build-plugin.mjs（正式打包）与 rebuild-bundle.mjs（check-bundle-sync 重建对比）
// 共用同一份参数对象——参数一旦漂移，重建对比闸要么永远红要么形同虚设。
// 改打包参数只改这里，两处同时生效。
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const relayRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// 以下注释是参数的历史沿革（从 build-plugin.mjs 移入，改动前先读）：
export function bundleOptions(outfile) {
  return {
    entryPoints: [join(relayRoot, "src", "index.ts")],
    // absWorkingDir 钉死（2026-10-10 A2 实测发现）：bundle 内 node_modules 的模块路径
    // 注解是相对 esbuild 工作目录记的，不钉则「同一份源码从不同 cwd 打包字节不同」
    // （从仓库根跑注解成 relay/node_modules/…、从 relay/ 跑是 node_modules/…）——
    // 历史部署位 bundle 均由 relay/ cwd 所出，故钉 relayRoot 保持逐字节兼容
    absWorkingDir: relayRoot,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18", // #17（2026-09-10）：内嵌 relay 真实下限=18（源码用 top-level await + 全局 fetch，node14 转译救不了）；老 Node 由壳侧 err 引导升级（见 main.rs EMBEDDED_RELAY_ERR）
    outfile,
    // better-sqlite3 是原生模块（.node 二进制）不可内联：bundle 进 ESM 后其运行时依赖
    // bindings 包的 __filename 在 ESM 语境未定义 → 任何环境首次 boot 即 ReferenceError
    // （2026-10-07 部署单沙盒首 boot 实锤，此前测试全走 tsx 源码未踩中）。运行时从
    // bundle 同目录 node_modules 解析——插件/桌面两形态发布都须随包携带
    // node_modules 内 better-sqlite3 完整运行时 require 闭包：bindings、
    // file-uri-to-path（缺 file-uri-to-path 同样 boot 必崩，2026-10-07 沙盒
    // 二度实锤；含 build/Release 原生二进制）
    external: ["bufferutil", "utf-8-validate", "better-sqlite3"],
    define: { "process.env.CC_DECK_PLUGIN": '"1"' },
    // banner 里不声明 createRequire 标识符——源码（如 cli-path.ts）静态 import { createRequire }
    // 时 esbuild 会原样保留该 import，banner 再 import 一份 = 重复声明 SyntaxError，
    // 整个 bundle 起不来（2026-09-16 事故）。动态取用无标识符冲突
    banner: { js: "const require = (await import('node:module')).createRequire(import.meta.url);" },
    logLevel: "info",
  };
}
