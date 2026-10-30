// conn-page-v2 连接页重设计三件测试：
//   relay 侧：devices.ts 台账纯函数（UA 族分类/dev_name 优先/id 稳定/upsert+cap+剪尾/
//     listDevices 排序与 online 标注）+ ws-server SNAPSHOT 携 relay_devices 键（静态锚）
//   前端静态锚（十点逐条锁）：①窄条隐藏 ②footer 退役+两钮归位 ③编辑轻交互（无常驻
//     rname-block 于桌面 connections 槽）④ghost 单源 #d-settings .row-share ⑤状态一行
//     （·端口·并单 st 行）⑥⑦（桌面远程源纯列表+svg 图标）⑧客户端模块（relay_devices
//     渲染+桌面 App 版本行退役）⑨尾行底线清零 ⑩副题统一六面板。
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDevice, touchDevice, listDevices } from "../src/devices.js";

let pass = 0;
let fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
function section(name: string) { console.log(name); }
const repoRoot = join(fileURLToPath(import.meta.url).replace(/\/[^/]*$/, ""), "..", "..");

const dirs: string[] = [];
async function main() {
  // ---------- relay：devices 台账 ----------
  section("\nR1 devices 台账（UA 分类/upsert/online）：");
  {
    const dir = mkdtempSync(join(tmpdir(), "ccr-connv2-"));
    dirs.push(dir);
    assert(classifyDevice("okhttp/4.9 cc-deck-mobile").kind === "phone", "UA 分类：okhttp/mobile → phone");
    assert(classifyDevice("Mozilla/5.0 (Macintosh) Tauri ccdeck/0.7").kind === "desktop", "UA 分类：Tauri/ccdeck → desktop");
    assert(classifyDevice("Mozilla/5.0 (iPhone) Safari").kind === "phone", "UA 分类：iPhone Safari → phone（手机浏览器）");
    assert(classifyDevice("Mozilla/5.0 (Windows) Chrome/120").kind === "browser", "UA 分类：Windows Chrome → browser");
    const d1 = touchDevice(dir, "okhttp/4.9", "iPhone 15");
    assert(d1.id.startsWith("dv-") && d1.name === "iPhone 15", "dev_name 在场优先（名称自定义）");
    const d1b = touchDevice(dir, "okhttp/4.9", "iPhone 15 Pro");
    const all1 = listDevices(dir);
    assert(all1.length === 1 && all1[0].name === "iPhone 15 Pro" && all1[0].last_seen >= d1.last_seen, "同 id upsert（改名+刷 last_seen，不重复行）");
    touchDevice(dir, "Mozilla/5.0 (Macintosh) Chrome/120");
    const all2 = listDevices(dir, new Set([d1b.id]));
    assert(all2.length === 2 && all2[0].id === d1b.id && all2[0].online === true && all2[1].online === false, "listDevices：online 活连接置顶标注、离线行不带假在线");
    // cap 12 + 30d 剪尾
    for (let i = 0; i < 20; i++) touchDevice(dir, `ua-unique-${i}`, `dev-${i}`);
    const capped = listDevices(dir);
    assert(capped.length <= 12, `台账 cap 12（实测 ${capped.length}）`);
    const raw = JSON.parse(readFileSync(join(dir, "relay-devices.json"), "utf-8")) as { devices?: unknown[] };
    assert(Array.isArray(raw.devices), "持久化文件形状（relay-devices.json）");
  }

  // ---------- relay：SNAPSHOT 键（静态锚） ----------
  section("\nR2 ws-server SNAPSHOT 携带：");
  {
    const wss = readFileSync(join(repoRoot, "relay/src/ws-server.ts"), "utf-8");
    assert(wss.includes("relay_devices: listDevices(cfg.dataDir"), "SNAPSHOT payload 含 relay_devices（listDevices 活连接标注）");
    assert(wss.includes('url.searchParams.get("dev_name")'), "ws 连接读取 dev_name 参数（端上自愿身份）");
  }

  // ---------- 前端：十点静态锚 ----------
  section("\nW1 十点逐条（settings-domain/index-005/base.css）：");
  const js = readFileSync(join(repoRoot, "web-console/js/settings-domain.js"), "utf-8");
  const html = readFileSync(join(repoRoot, "web-console/index-005.html"), "utf-8");
  const css = readFileSync(join(repoRoot, "web-console/css/base.css"), "utf-8");
  {
    assert(css.includes("#d-settings .workspace-head { display: none; }"), "①窄条退役：设置域 workspace-head 隐藏（六面板统一）");
    assert(js.includes('<div class="s">本机服务 · 远程数据源 · 已连客户端</div>'), "①层级感替代：连接页主标+副题");
    assert((js.match(/<div class="v8-sethead"><div class="t">[^<]+<\/div><div class="s">/g) || []).length >= 6, "①六面板副题全覆盖（统一层级语言）");
    assert(css.includes("#d-settings .workspace-footer { display: none; }"), "②底部独立按钮区退役");
    assert(js.includes('data-settings-verify type="button" title="逐项探测'), "②验证收纳本机 relay 卡（ghost 小钮）");
    assert(js.includes("查看连接帮助 ↗"), "②帮助收纳远程源卡尾（低调文字链）");
    assert(js.includes("data-conn-rename-open") && js.includes("data-conn-rename-close"), "③编辑轻交互：行内改名开/收委托在位");
    const connLiveSeg = js.slice(js.indexOf("liveSetHtml(connLive,"), js.indexOf("if (shellDiag) void refreshRelayDiag"));
    assert(!/relayNameRowHtml\((false|true)\)/.test(connLiveSeg), "③桌面 relay 槽无常驻改名块（调用形态退役；注释提及不算）");
    assert(connLiveSeg.includes('· ${stateText} · 端口 ${relayPort}</div>'), "⑤状态一行紧凑（名称·状态·端口一气呵成）");
    assert(connLiveSeg.includes('class="meta">端口') === false, "⑤meta 端口行退役（不再三行说一件事）");
    assert(css.includes("#d-settings .row-share {"), "④ghost 单源化（#d-settings 域全域同规格）");
    assert(css.includes("#d-settings .row-share:focus-visible"), "④ghost 态面齐（focus-visible）");
    const devSeg = js.slice(js.indexOf("const devLive ="), js.indexOf("const provLive ="));
    assert(devSeg.includes("relay_devices") && devSeg.includes("icon-phone"), "⑧客户端模块=relay_devices 真实台账+设备图标");
    assert(!devSeg.includes("版本 "), "⑧桌面 App 版本行退役（关于页重复概念清除）");
    const remoteSeg = js.slice(js.indexOf("function cloudSettingsRows"), js.indexOf("function cloudMobileLaneInner"));
    assert(js.includes('<use href="#icon-cloud"></use>') && !remoteSeg.includes(">☁</span>"), "⑦字符图标退役（桌面/云槽远程源行 ☁→icon-cloud）");
    assert(css.includes(".settings-list > :last-child { border-bottom: none; }"), "⑨卡内尾行底线清零");
    assert(html.includes('symbol id="icon-phone"') && html.includes('symbol id="icon-cloud"'), "⑦icon sprite 增补（phone/cloud）");
    assert(js.includes("客户端 · 连到本机的终端"), "模块③命名（以本机为源的客户端清单）");
    assert(readFileSync(join(repoRoot, "web-console/js/mobile.js"), "utf-8").includes("mobileDevicesLane") && readFileSync(join(repoRoot, "web-console/js/mobile.js"), "utf-8").includes("客户端 · 连到本机的终端"), "⑧移动端同源：连接与设备详情含客户端 lane（relay_devices）");
    assert(!js.includes("本设备与配对</h5>"), "旧「本设备与配对」模块名退役");
  }

  console.log(`\n========== conn-page-v2 套件：${pass} 通过 / ${fail} 失败 ==========`);
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 尽力 */ } }
  process.exit(fail > 0 ? 1 : 0);
}

void main();
