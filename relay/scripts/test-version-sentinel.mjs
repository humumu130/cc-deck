// W-VERSIONREVERT-R1 断言（1105）：P1 WatchPaths 三路监听 + P2-3 kind 第 4 位缺省 0
// + P2-1 mtime-only 分流 + P2-2 app-missing 落账——bash 哨脚本以隔离 dry 跑断言，
// plist/源码静态断言。node 直跑（哨=部署脚本家族，与 ts 套件分离）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../../", import.meta.url)));
const SCRIPT = join(ROOT, "scripts", "version-sentinel.sh");
const PLIST = join(ROOT, "deploy", "online.humumu.ccdeck.version-sentinel.plist");

let pass = 0, fail = 0;
const assert = (c, name) => { if (c) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name}`); } };

// P1：WatchPaths 三路（Info.plist + bin + Resources——1105 07:24 bin 级热换漏捕根修）
const pl = readFileSync(PLIST, "utf-8");
assert(pl.includes("Contents/Info.plist") && pl.includes("Contents/MacOS/cc-deck-nova") && pl.includes("Contents/Resources"),
  "P1 WatchPaths 三路监听（Info.plist+bin+Resources）在部署模板");

// 隔离 dry：kind 判定与 mtime 分流（真 App 为 cur，prev 手造）
const DIR = mkdtempSync(join(tmpdir(), "vs-r1-"));
const env = { ...process.env, CCR_DATA_DIR: DIR, SENTINEL_SKIP_PS: "1" };
const run = () => execFileSync("/bin/bash", [SCRIPT, "--dry"], { env, encoding: "utf-8" });
const setPrev = (o) => writeFileSync(join(DIR, "version-sentinel.json"), JSON.stringify(o) + "\n");

// P2-3：稳定版 0.7.0 跟 test.96 后 → upgrade（旧码 [0,7,0]<[0,7,0,96] 前缀序误标 revert）
setPrev({ version: "0.7.0-test.96-nova", fingerprint: "aaaa1111", plist_mtime: 100 });
assert(run().includes("upgrade"), "P2-3 稳定版跟 test 版后判 upgrade（第 4 位缺省 0）");
// P2-3b：真回退（prev 高于当前真版本——App 现为 test.98，prev 造 99）仍判 revert
setPrev({ version: "0.7.0-test.99-nova", fingerprint: "aaaa1111", plist_mtime: 100 });
assert(run().includes("revert"), "P2-3b 真回退（test.99 → 当前 test.98）仍判 revert");

// P2-1：mtime-only（版本同+指纹同）→ 静默记账分支
rmSync(join(DIR, "version-sentinel.json"));
assert(run().includes("基线就绪"), "P2-1 前置：首跑建基线");
const st = JSON.parse(readFileSync(join(DIR, "version-sentinel.json"), "utf-8"));
st.plist_mtime = 1; // 仅 mtime 变（版本/指纹同）
writeFileSync(join(DIR, "version-sentinel.json"), JSON.stringify(st) + "\n");
assert(run().includes("mtime-only"), "P2-1 mtime-only（版本同+指纹同）走静默记账分支");

// P2-2：app-missing 落账路径（App 缺失形态无法安全真测——不动生产 .app，静态断言）
const src = readFileSync(SCRIPT, "utf-8");
assert(/app-missing/.test(src) && src.includes("LEDGER"), "P2-2 app-missing 落账路径在源码（App 缺失不静默）");
rmSync(DIR, { recursive: true, force: true });
console.log(`\nversion-sentinel: ${pass}/${pass + fail}${fail ? "（有红）" : ""}`);
process.exit(fail ? 1 : 0);
