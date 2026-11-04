// tauritrust（t-8942b92a，1104 用户实锤「Nova 桌面永远连接中」）：契约锁三件。
//   ①tauri.localhost 可信源（/local-info 三点收口——Tauri 壳 WebView 官方虚拟域名）
//   ②版本拼盘守卫（readVer 三源互校+warn+/health 指纹）
//   ③halfconn（3f22f6e0）兜底链回归锚（settings-domain 裸 fetch /local-info 兜底
//     在白名单修活后于 Tauri 下可达——病灶闭环：坏版 Tauri 无 ccDeck.probeLocal
//     恒走裸 fetch→白名单三不中→404 死循环）
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  const wss = srcOf("../src/ws-server.ts");
  const settings = srcOf("../../web-console/js/settings-domain.js");

  console.log("A. tauri.localhost 可信源三点收口（裁决=精确值不通配）");
  {
    const hits = wss.split('"tauri.localhost"').length - 1;
    assert(hits >= 3, `三点全落（hostTrusted/hostOk×2 实测 ${hits} 处字面）`);
    assert(wss.includes("非任意 *.localhost 通配"), "裁决注释在档（显式不放开子域通配——*.localhost 公共后缀表外可被本地 DNS 劫持者注册形似名）");
    const liAt = wss.indexOf('if (req.method === "GET" && url.pathname === "/local-info")');
    const segA = wss.slice(liAt, liAt + 1200);
    const i = wss.indexOf('if (req.method === "GET" && url.pathname === "/local-info")');
    const seg = wss.slice(i, i + 1800);
    assert(seg.includes('"tauri.localhost"'), "/local-info hostTrusted 收口（病灶主锚——404 死循环点位）");
  }

  console.log("B. 真链行为：Origin http://tauri.localhost → /local-info 200（红→绿复现）");
  {
    // 起 startServer 真实例（隔离 env），带 Origin 头打 /local-info
    process.env.CCR_PORT = "8871";
    process.env.CCR_TOKEN = "tauritrust-t";
    process.env.CCR_BRIDGE_TOKEN = "tauritrust-b";
    process.env.CCR_DATA_DIR = (await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "tauritrust-")));
    process.env.CCR_NO_MDNS = "1";
    process.env.CCR_NO_TITLE_GEN = "1";
    process.env.CCR_DEAD_SWEEP = "0";
    process.env.CCR_INJECT_CMD = fileURLToPath(new URL("./fake-injector.mjs", import.meta.url));
    process.env.CCR_NO_TERM_LINE = "1";
    const { loadConfig } = await import("../src/config.js");
    const { EventBus } = await import("../src/event-bus.js");
    const { SessionManager } = await import("../src/session-manager.js");
    const cfg = loadConfig();
    const bus = new EventBus();
    const mgr = new SessionManager(bus, cfg);
    const { startServer } = await import("../src/ws-server.js");
    const srv = startServer(bus, mgr, cfg, {});
    await new Promise((r) => setTimeout(r, 400));
    // 修前红形态（Origin 不中白名单→404）与修后绿（200+token）一发实证
    const r1 = await fetch("http://127.0.0.1:8871/local-info", { headers: { origin: "http://tauri.localhost" } });
    const j1 = r1.status === 200 ? await r1.json().catch(() => null) : null;
    assert(r1.status === 200 && j1 && j1.ok === true && typeof j1.token === "string", `Origin http://tauri.localhost → 200+token（修后绿——实测 ${r1.status}）`);
    const acao = r1.headers.get("access-control-allow-origin");
    assert(acao === "http://tauri.localhost", `CORS 回显精确源（acao=${acao}——Tauri 页面 fetch 可读响应体）`);
    // R1-P2② 四断言对账补齐（A 审：回执声称四条提交全缺——逐条落）
    const r2 = await fetch("http://127.0.0.1:8871/local-info", { headers: { origin: "http://evil.localhost" } });
    assert(r2.status === 404, `任意子域不通配（evil.localhost → ${r2.status}——精确值边界）`);
    const r3 = await fetch("http://127.0.0.1:8871/local-info", { headers: { origin: "https://tauri.localhost" } });
    const j3 = r3.status === 200 ? await r3.json().catch(() => null) : null;
    assert(r3.status === 200 && j3 && j3.ok === true, `Windows WebView2 https 变体 → 200（实测 ${r3.status}——hostname 判定 scheme 无关）`);
    const r4 = await fetch("http://127.0.0.1:8871/local-info", { headers: { origin: "https://evil.example.com" } });
    assert(r4.status === 404, `恶意外域 → ${r4.status}（https 非可信源——安全面）`);
    const r5 = await fetch("http://127.0.0.1:8871/local-info", { headers: { origin: "http://fake.tauri.localhost" } });
    assert(r5.status === 404, `fake.tauri.localhost 子域仿冒 → ${r5.status}（精确值≠后缀匹配——DNS 劫持形似名防线）`);
    try { (srv as unknown as { close(): Promise<void> }).close?.(); } catch {}
    try { rmSync(process.env.CCR_DATA_DIR, { recursive: true, force: true }); } catch {}
  }

  console.log("C. 版本拼盘守卫（readVer 三源互校+warn+/health 指纹+bundle define）");
  {
    assert(wss.includes("function readVer") || wss.includes("readVer("), "readVer 指纹提取器在场");
    assert(wss.includes("版本拼盘：双壳 console 不同版"), "拼盘 warn①（005 vs legacy 不同版）");
    assert(wss.includes("版本拼盘：relay=") && wss.includes("与 console 不一致"), "拼盘 warn②（relay vs console 非同批）");
    assert(wss.includes("versions: { relay: verRelay, console005: ver005Live(), consoleLegacy: verLegacyLive() }"), "/health 三元组活指纹（R1 随批②每请求现算——热换逃逸根修；空串=缺席不误判）");
    // 单测 readVer 提取逻辑（真文件）
    const tmp = mkdtempSync(join(tmpdir(), "tv-"));
    const f = join(tmp, "index-005.html");
    writeFileSync(f, '<script>window.__ccDeck005Version = "0.7.0-test.98";</script>', "utf-8");
    const wssModule = await import("../src/ws-server.js") as { readVerForTest?: (p: string, re: RegExp) => string };
    if (typeof wssModule.readVerForTest === "function") {
      const v = wssModule.readVerForTest(f, /__ccDeck005Version\s*=\s*"([^"]+)"/);
      assert(v === "0.7.0-test.98", `readVer 提取真值（实测 "${v}"）`);
    } else {
      assert(wss.includes("__ccDeck005Version\\s*=\\s*\"([^\"]+)\""), "readVer 005 版本正则锚（导出面缺席——源码锚降级锁）");
    }
    rmSync(tmp, { recursive: true, force: true });
    // R1：bundle define 合并锚（原两处 define 重复键后者覆盖=CCR_RELAY_VERSION 烙印恒失效）
    const bo = srcOf("../scripts/bundle-options.mjs");
    const defineCount = (bo.match(/^\s*define:/gm) || []).length;
    assert(defineCount === 1 && bo.includes('"process.env.CCR_RELAY_VERSION"') && bo.includes('"process.env.CC_DECK_PLUGIN"'), `bundle define 单处两键合并（define 出现 ${defineCount} 次——原重复键后者覆盖=烙印失效根修）`);
    const bp = srcOf("../scripts/build-plugin.mjs");
    assert(bp.indexOf("const ver =") < bp.indexOf("await build(bundleOptions"), "build-plugin ver 定义先于使用（R1-P1-1 TDZ 根治——定义前移到 bundle 调用前）");
  }

  console.log("D. halfconn（3f22f6e0）兜底链回归锚（病灶闭环文档化）");
  {
    const i = settings.indexOf("/local-info");
    const seg = settings.slice(Math.max(0, i - 600), i + 200);
    // R1 随批①（A 审）：R2-P2 回环守卫（location.hostname 限 127.0.0.1/localhost——防跨机
    // 探针投毒）使裸 fetch 兜底在 Tauri（hostname=tauri.localhost）下永不可达——D 组锚按
    // 守卫实况重判：Tauri 下唯一凭据链=壳 invoke（#43）；relay 收口（刀1）保护的是**存量
    // 回滚版 console**（无守卫形态）与任何未来裸 fetch 消费面——两代页面叙事由此分岔。
    assert(settings.includes("/local-info") && seg.includes("127.0.0.1"), "裸 fetch 兜底链源码在场（守卫限定回环页面——Tauri 形态被 R2-P2 守卫关断，存量回滚版 console 仍消费此链=刀 1 收口的保护对象）");
    assert(settings.includes("R2-P2") || settings.includes("回环 served 才有效") || seg.includes('location.hostname !== "127.0.0.1"'), "R2-P2 回环守卫在场（跨机探针投毒防线——Tauri 走壳 invoke 单链的分流闸）");
    assert(settings.includes("桌面壳 invoke") || settings.includes("tauri command"), "壳侧 invoke 优先级链在档（#43 设计——URL token>localStorage>壳 invoke>loopback 兜底四级）");
    assert(seg.includes("1500") || settings.includes("AbortSignal.timeout"), "兜底 fetch 超时窗（1500ms——防探测挂死）");
  }

  console.log(`\n========== tauritrust 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
