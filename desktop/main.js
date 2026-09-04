// CC Deck 桌面壳（Electron）：本地加载 web-console，默认连本机 relay。
// 安全基线：contextIsolation 默认开、nodeIntegration 关（纯渲染 UI 不需要 Node）、
// 不加载任何远程内容（云桥只走 WS 数据通道）。
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require("electron");
const path = require("node:path");

const SMOKE = process.argv.includes("--smoke");

// Windows 任务栏/通知分组需要稳定的 AUMID
app.setAppUserModelId("online.humumu.ccdeck.desktop");

// 单实例：二次启动聚焦已有窗口；二实例无状态可清理，立即终止防闪窗/双托盘竞态
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

function consoleHtml() {
  // 开发：desktop/ 下直接跑，页面在 ../web-console/；
  // 打包：extraFiles 把 web-console/ 放到 exe 旁（asar 外，改动 UI 只需替换该目录）
  return app.isPackaged
    ? path.join(path.dirname(app.getPath("exe")), "web-console", "index.html")
    : path.join(__dirname, "..", "web-console", "index.html");
}

let win = null;
let tray = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "CC Deck",
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(consoleHtml());
  // 外链走系统浏览器，壳内不导航到任意站点
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // 只允许本地文件页；preload 注入的 probeLocal 不得落入远程页
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) e.preventDefault();
  });
  win.on("close", (e) => {
    if (!quitting && !SMOKE && tray) {
      e.preventDefault();
      win.hide(); // 关窗到托盘
    }
  });
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png")).resize({ width: 16 });
    if (img.isEmpty()) return; // 图标缺失不建托盘（空图 new Tray 在 Windows 抛错），关窗直退
    tray = new Tray(img);
    tray.setToolTip("CC Deck");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "显示主窗口", click: () => showWin() },
        { type: "separator" },
        { label: "退出", click: () => { quitting = true; app.quit(); } },
      ]),
    );
    tray.on("double-click", () => showWin());
  } catch {
    tray = null; // 托盘失败不致命：主窗口照常，close 时不再隐藏到托盘
  }
}

function showWin() {
  if (!win) return;
  win.show();
  win.focus();
}

// 本机 relay 探测代理：file:// 页面 fetch 带 Origin: null，进不了 relay 白名单；
// 主进程是本机可信进程（无 Origin 走 Host 判定分支），与页面版探测同信任模型
ipcMain.handle("cc-deck:probe-local", async () => {
  try {
    const r = await fetch("http://127.0.0.1:8787/local-info", { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && j.ok && j.token ? j : null;
  } catch {
    return null;
  }
});

app.on("second-instance", () => showWin()); // 顶层注册：就绪前到来的二次启动消息不丢

app.whenReady().then(() => {
  createTray();
  createWindow();
});

app.on("before-quit", () => { quitting = true; });

// 冒烟模式：页面加载后验证 nacl 加载 + 本机探测写回，输出结论并以退出码报告。
// 本机 relay 在跑时全链路（file:// 加载 → 探测代理 → token 写回）都覆盖到
if (SMOKE) {
  app.whenReady().then(() => new Promise((resolve) => {
    const t = setTimeout(() => finish(false, "timeout: 页面加载超时"), 45000); // CI 冷启动含 Defender 扫描，放宽
    let errors = 0;
    win.webContents.on("console-message", (e, legacyLevel) => {
      const level = typeof e === "object" && e.level !== undefined ? e.level : legacyLevel; // 44 新事件对象签名
      if (level >= 3) errors++;
    });
    win.webContents.once("did-finish-load", () => {
      // 等 init() 的探测 + toast + 首轮渲染
      setTimeout(async () => {
        clearTimeout(t);
        try {
          const r = await win.webContents.executeJavaScript(`(async () => {
            const nacl = typeof window.nacl !== "undefined";
            const lan = (JSON.parse(localStorage.getItem("ccd_servers") || "[]").find(s => s.kind === "lan"));
            return { nacl, wsUrl: lan ? lan.wsUrl : null, hasToken: !!(lan && lan.token) };
          })()`);
          const ok = r.nacl && r.hasToken && !!r.wsUrl;
          finish(ok, JSON.stringify(r) + (errors ? ` consoleErrors=${errors}` : ""));
        } catch (e) {
          finish(false, String(e));
        }
      }, 4000);
    });
    function finish(ok, detail) {
      console.log(`[smoke] ${ok ? "PASS" : "FAIL"} ${detail}`);
      app.exit(ok ? 0 : 1);
      resolve();
    }
  }));
}
