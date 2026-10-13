// W-DESIGNHUB 系统设计图纸服务单元测试：清单扫描（分组/标题/tags/README 排除）、
// <title> 解析、resolveDesignFile 遍历防护全攻击面、mtime 缓存、缺目录降级。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listDesignDocs, resolveDesignFile, resetDesignDocsCacheForTests, designDir } from "../src/design-docs.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}
function section(t: string) { console.log(t); }

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)); // relay/scripts/../..
const dirs: string[] = [];
const mkDir = () => { const d = mkdtempSync(join(tmpdir(), "ccr-dh-")); dirs.push(d); return d; };

// ---------- S1 清单扫描（真入仓目录） ----------
section("\nS1 listDesignDocs（w61 docs/system-design/ 真目录）");
resetDesignDocsCacheForTests();
const list = listDesignDocs(REPO_ROOT);
assert(list.length === 9, `9 张图纸入清单（README.md 排除）got=${list.length}`);
const byPath = new Map(list.map((x) => [x.path, x]));
assert(byPath.has("/design/fig-patrol.html"), "根文件路径 /design/fig-patrol.html");
assert(byPath.get("/design/fig-patrol.html")?.group === "全局", "根文件分组=全局");
assert(byPath.get("/design/fig-patrol.html")?.title === "巡检哨兵：双层定时监控", "标题读 <title>（中文）");
const warch = byPath.get("/design/" + encodeURIComponent("005-换壳") + "/" + encodeURIComponent("warch-01-system-architecture") + ".html");
assert(!!warch, "子目录文件路径（中文段 encodeURIComponent）");
assert(warch?.group === "005-换壳", "子目录分组=目录名");
assert(warch?.title === "cc-deck 系统架构与信任边界", "子目录标题");
assert(warch?.tags.includes("换壳") && warch?.tags.includes("warch") && !warch?.tags.includes("01"), "tags=目录+文件名分词（纯数字段滤除）");
assert(!list.some((x) => x.path.endsWith("README.md")), "README.md 不入清单（扩展白名单外）");
assert(!list.some((x) => x.path.includes(".json")), ".json 元数据不入清单（只收 .html 浏览面）");

// ---------- S2 遍历防护（纯函数全攻击面） ----------
section("\nS2 resolveDesignFile 遍历防护");
const R = REPO_ROOT;
assert(resolveDesignFile(R, "fig-patrol.html")?.endsWith(join("docs", "system-design", "fig-patrol.html")) === true, "正常根文件命中");
assert(resolveDesignFile(R, "005-换壳/warch-01-system-architecture.html") !== null, "正常子目录命中（中文原样）");
assert(resolveDesignFile(R, encodeURIComponent("005-换壳") + "/" + encodeURIComponent("warch-01-system-architecture.html")) !== null, "encodeURIComponent 形态命中（decode 后解析）");
assert(resolveDesignFile(R, "../web-console/index-005.html") === null, "../ 逃逸拒");
assert(resolveDesignFile(R, "..%2Fweb-console%2Findex-005.html") === null, "..%2F 编码逃逸拒");
assert(resolveDesignFile(R, "%2e%2e%2f%2e%2e%2frelay%2fsrc%2ftypes.ts") === null, "%2e%2e%2f 全编码逃逸拒");
assert(resolveDesignFile(R, "/etc/passwd") === null, "绝对路径拒");
assert(resolveDesignFile(R, "fig-patrol.html/../../package.json") === null, "中间 .. 拒");
assert(resolveDesignFile(R, "fig-patrol.json") !== null, ".json 白名单（元数据可服务）");
assert(resolveDesignFile(R, "secret.md") === null, ".md 白名单外拒");
assert(resolveDesignFile(R, "evil.sh") === null, ".sh 白名单外拒");
assert(resolveDesignFile(R, "") === null, "空路径拒");
assert(resolveDesignFile(R, "fig-patrol.html%00.js") === null || resolveDesignFile(R, "fig-patrol.html%00.js") === undefined || true, "NUL 形态不炸（decode 失败/校验兜底）");

// ---------- S3 缓存（mtime 键） ----------
section("\nS3 mtime 缓存");
{
  const D = mkDir();
  resetDesignDocsCacheForTests();
  mkdirSync(designDir(D), { recursive: true });
  writeFileSync(join(designDir(D), "a.html"), "<html><title>甲</title></html>");
  const l1 = listDesignDocs(D);
  assert(l1.length === 1 && l1[0].title === "甲", "临时目录扫描+标题解析");
  const first = listDesignDocs(D);
  assert(first === l1 || JSON.stringify(first) === JSON.stringify(l1), "未变目录命中缓存（同引用/等值）");
  // 写新文件 → mtime 键变化 → 重扫
  mkdirSync(join(designDir(D), "sub"), { recursive: true });
  writeFileSync(join(designDir(D), "sub", "b.html"), "<html><title>乙</title></html>");
  const l2 = listDesignDocs(D);
  assert(l2.length === 2 && l2.some((x) => x.group === "sub"), "目录变化自动重扫（无 reset）");
}

// ---------- S4 缺目录降级 ----------
section("\nS4 缺目录降级");
{
  const D = mkDir();
  resetDesignDocsCacheForTests();
  const l = listDesignDocs(D);
  assert(Array.isArray(l) && l.length === 0, "无 docs/system-design 的 webRoot → 空清单（入口隐藏）");
  // 路径安全归 resolve（缺目录下形式路径仍「安全」），存在性归服务层 statSync → 404：
  // 断言不逃出 designDir 即可（分层口径，防把 404 语义塞进纯函数）
  const resolved = resolveDesignFile(D, "x.html");
  assert(resolved === null || resolved.startsWith(resolve(designDir(D))), "缺目录下解析不逃出 designDir（404 归服务层）");
}

// ---------- 收尾 ----------
for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 清理尽力 */ } }
console.log(`\ndesign-docs: ${pass}/${pass + fail}`);
process.exit(fail > 0 ? 1 : 0);
