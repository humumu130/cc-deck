// ---------- ABI 烙印与运行时自比对（DEV-39 清单3 / arch R-7 根因面） ----------
// 现状缺口：ABI 三重闸（build-plugin abi-gate ①②③ + CI 侧同款）拦的是「坏包流出」
// ——构建时点确认构建机 node 档位与闭包二进制匹配。但 11-24 事故类（产物闭包 ABI
// 与**运行时** node 档位错配 → ERR_DLOPEN_FAILED → sqlite 恒降级 json）闸门看不见：
// 产物被部署到哪个 node 上跑，构建时点无从核。本模块补根因面：
//   构建侧：bundle-options.mjs define 三键（CCR_BUILD_NODE_VERSION / CCR_BUILD_NODE_ABI /
//     CCR_BUILD_PLATFORM）把构建机 node 档位烙进 relay bundle（与 CCR_RELAY_VERSION
//     烙印同机制）；build-plugin.mjs 同时烙进 plugin.json 的 build 段（产物 manifest
//     可见——不打开 bundle 也能读）。
//   运行侧（本文件）：boot 自比对 process.versions vs 烙印——mismatch 即打醒目横幅
//     （11-24 形态当场可见，不等降级症状被人视出），并经 /health（buildRuntimeMatch
//     透出）与 patrol 轻探针（abi-mismatch 告警键）两面暴露。
// 降级语义：tsx 源码跑（npm run dev / 测试）无 define 三键=缺席——match="unstamped"，
//   不比对不告警（与 tauritrust verRelay 烺印缺席的同款降级语义：缺席≠错误）。

// esbuild define 替换点：bundle 内为字面量（"22.23.4" / 127 / "darwin-arm64"）；
// tsx 源码跑=process.env 上不存在的键 → undefined。const 收口（防每次读点重复取）。
const STAMPED_NODE: string | undefined = process.env.CCR_BUILD_NODE_VERSION;
const STAMPED_ABI: string | undefined = process.env.CCR_BUILD_NODE_ABI;
const STAMPED_PLATFORM: string | undefined = process.env.CCR_BUILD_PLATFORM;

export interface BuildRuntimeMatch {
  /** 烙印在产物里（bundle define 形态）；false=tsx 源码跑等无烙印场景。 */
  stamped: boolean;
  buildNode?: string;
  buildAbi?: number;
  buildPlatform?: string;
  runtimeNode: string;
  runtimeAbi: number;
  runtimePlatform: string;
  /** ok=档位一致；mismatch=11-24 事故形态（当场报警）；unstamped=源码跑不比对。 */
  match: "ok" | "mismatch" | "unstamped";
  mismatchKeys: string[];
}

/** 运行时自比对（纯函数，无 IO——/health 每请求与 boot 各调一次）。 */
export function buildRuntimeMatch(): BuildRuntimeMatch {
  const runtimeAbi = Number(process.versions.modules);
  const base = {
    runtimeNode: process.versions.node,
    runtimeAbi,
    runtimePlatform: `${process.platform}-${process.arch}`,
  };
  if (STAMPED_NODE === undefined && STAMPED_ABI === undefined && STAMPED_PLATFORM === undefined) {
    return { stamped: false, ...base, match: "unstamped", mismatchKeys: [] };
  }
  const mismatchKeys: string[] = [];
  if (STAMPED_NODE !== undefined && STAMPED_NODE !== base.runtimeNode) {
    // 次版本差异（22.23.4 vs 22.23.5）不构成 ABI 事故——ABI 同档即安全；只把 node
    // 主版本差异记 mismatch（ABI 已含主档语义，这里只作冗余佐证面）
    if (STAMPED_NODE.split(".")[0] !== base.runtimeNode.split(".")[0]) mismatchKeys.push("node-major");
  }
  const buildAbi = STAMPED_ABI !== undefined ? Number(STAMPED_ABI) : NaN;
  if (Number.isFinite(buildAbi) && buildAbi !== runtimeAbi) mismatchKeys.push("abi");
  if (STAMPED_PLATFORM !== undefined && STAMPED_PLATFORM !== base.runtimePlatform) mismatchKeys.push("platform");
  const match = mismatchKeys.length ? "mismatch" : "ok";
  return {
    stamped: true,
    buildNode: STAMPED_NODE,
    buildAbi: Number.isFinite(buildAbi) ? buildAbi : undefined,
    buildPlatform: STAMPED_PLATFORM,
    ...base,
    match,
    mismatchKeys,
  };
}

let alarmed = false;

/** boot 自检横幅（index.ts 启动序列调用，每进程一次）：mismatch=醒目报警（11-24 形态）；
 *  ok=一行确认（健康可见，与 probe-sqlite 同款粒度）；unstamped=源码跑静默。 */
export function abiSentinelAtBoot(): BuildRuntimeMatch {
  const m = buildRuntimeMatch();
  if (m.match === "mismatch" && !alarmed) {
    alarmed = true;
    console.error(`[abi-sentinel] ⚠️⚠️  构建烙印与运行时 node 档位错配（11-24 恒降级事故形态）：`);
    console.error(`[abi-sentinel] ⚠️  构建 node ${m.buildNode} ABI ${m.buildAbi} ${m.buildPlatform} vs 运行 node ${m.runtimeNode} ABI ${m.runtimeAbi} ${m.runtimePlatform}（错配面 ${m.mismatchKeys.join("/")}）`);
    console.error(`[abi-sentinel] ⚠️  后果预判：better-sqlite3 闭包 dlopen 失败 → 读面降级 json 档（存储态见 /health storage 段）。修复=换回构建档位 node 或用对应档位重出包。`);
  } else if (m.match === "ok") {
    console.log(`[abi-sentinel] 烙印核对 ok（node ${m.buildNode} ABI ${m.buildAbi} ${m.buildPlatform}）`);
  }
  return m;
}

/** 测试面：清一次性报警标志。 */
export function resetAbiSentinelForTest(): void {
  alarmed = false;
}
