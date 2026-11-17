// W-FZONE-B1（1111 拍板方案 B · 批一）：右侧文件工作区——tab 系统 + 容器（拖宽/收起/记忆）。
// W-FZONE-R4（1112 用户四轮打回·第四轮定谳「在外面，在右侧」）：工作区=app 内容区级右列——
// fzone+4px sash 与 session-detail 并列为 .session-shell 子级（不在会话面板内、head 不压工作区）；
// 窄窗禁浮层（<1200 覆盖媒体查询删除，任何宽度都是真实列）+冷启必收起（OPEN_KEY 全退役——P2 批五清账）+
// 极窄 <1000 单向自动收起（NARROW_W）。宽度 440；W-UIB0 clamp[340,1200]；tab/内容链路不变。
// 内容加载委托 session-domain 注册的 window.__ccDeck005FzoneLoad(el, sid, path)（复用
// fetchArtifact/mdHtml/synHtml 闭包内管线——本文件零数据面）；图标委托 __ccDeck005ArtIconHtml。
// 批一范围：md/代码/图片三格式 + 点击入口闭环；批二（W-FZONE-B2）：格式矩阵（pdf 原生 viewer/
// 音频/视频——session-domain 侧）+ 产物自动推 tab（autoOpen 不抢焦点+「新」角标）+ ⌘1-8 直达
// + 工作空间树抽屉（降级形态：已登记产物按目录分组——relay 无列目录命令）；diff=无通道降级。
(function () {
  "use strict";
  const W_KEY = "ccd_fzone_w"; // P2 批五：OPEN_KEY 全退役（读写双点）——R4 冷启必收起后零消费者，清账
  const root = document.getElementById("fzone");
  if (!root) return;
  const toolsEl = root.querySelector("[data-fz-tools]");
  const tabsEl = root.querySelector("[data-fz-tabs]");
  const bodyEl = root.querySelector("[data-fz-body]");
  const state = { tabs: [], active: null, seq: 0, lastSid: null }; // W-FZONE-B1-R1 P2-①：sid 单值移除（tab 各带 sid），lastSid=切会话清空幂等守卫
  // W-FZONE-R2：per-sid 暂存表（切会话 tab 保留——见 resetForSession 注释块）+pane 跨会话保活表
  const stash = new Map(); // sid → { tabs, active }
  const panes = new Map(); // tabId → pane 元素（detach 不销毁；LRU 淘汰/close 时才 unload）
  const STASH_MAX = 8;
  const loadFn = () => (typeof window.__ccDeck005FzoneLoad === "function" ? window.__ccDeck005FzoneLoad : null);
  const iconHtml = (name) => (typeof window.__ccDeck005ArtIconHtml === "function" ? window.__ccDeck005ArtIconHtml(name) : "");

  // W-UIP2 件二：窄窗阈值提前定义（setOpen 的 yield 链引用——原 :473 区 const 提升不可达）
  const NARROW_W = 1200; // 1200=939-1071 备案带外沿+composer 全按钮零溢出实测下界（R4-R1 九档扫描）
  let autoYielded = false; // 列表让位来源记账：true=本进程自动收起（fzone 收起时可还原）；用户手动收/呼出置 false
  function yieldQueue(on, announce) {
    const q = document.querySelector("#d-session .queue");
    if (!q) return;
    q.classList.toggle("fz-yield", on);
    autoYielded = on ? true : false;
    if (on && announce) { try { if (window.__ccDeck005B4 && typeof window.__ccDeck005B4.toast === "function") window.__ccDeck005B4.toast("窄屏：会话列表已自动收起给工作区让位（工作区工具行「列表」可呼出）"); } catch (_) {} }
    renderTools();
  }

  // ---------- 宽度/收起（记忆：localStorage 持久——任务书「收起/展开记忆」） ----------
  // W-FZONE-R3：宽度策略照 WorkBuddy——默认 440（useState(440)）；W-UIB0 上限 1200
  // （Math.min(Math.max(w,340),800) 同构）；72vw 上位护栏为我方窄窗浮层配套（<1200 面板 absolute
  // 覆盖态防超窗——WorkBuddy 桌面窗最小宽足够无需此护栏，宽屏下 72vw≥864>800 零感知）。
  // W-FZONE-R4 P1-2 修（审 B）：浮层退役后 72vw 护栏在 <1111px 区间护不住（0.72*1111≈800>可用）——
  // 真实列时代并入可用空间上限 availMax（视口 − queue 右缘(含 rail 实算) − sash − 会话列保底储备）：
  // 极窄窗「头部钮可再开」与再开可用性自洽（会话列不被 flex-shrink:0 面板压到 0）。
  // W-FZONE-R4-R1 刀三（审二 P2-① 1000px 档对话列 215px+composer 按钮溢出实录）合流：保底储备取
  // 实测口径 CHAT_FIT=442——审 B 的 CHAT_MIN 360 是「列宽」口径，列内 chrome（padding/margin ≈68px）
  // 吃掉后 composer 实得 ~230px 仍溢出；CDP 逐宽实测 composer 按钮行最小内容宽 366px，全容纳需
  // cbW≥366 → 储备 360+68+14 余量。效果：≥1071px 窗宽面板全容纳按钮行；极窄（avail<340 面板下限）
  // 下限优先——939-1071 带手动再开 composer 仍挤（面板 340 下限语义保留，R4-R1 备案），<1200 跨入
  // 已自动收起（刀二）。
  const CHAT_FIT = 442; // 会话列保底储备（R4-R1 刀三实测口径：审 B CHAT_MIN 360 列宽保底+列内 chrome≈68+余量 14——超集覆盖）
  function availMax() {
    const q = document.querySelector("#d-session .queue");
    const qRight = q ? Math.round(q.getBoundingClientRect().right) : 297; // 缺省 62(rail)+235(queue)
    return Math.max(340, Math.floor(window.innerWidth - qRight - 4 - CHAT_FIT));
  }
  function clampW(w) { return Math.max(340, Math.min(1200, availMax(), Math.round(window.innerWidth * 0.85), w)); } // W-UIB0（1117 用户三令）：上限 800→1200+0.72vw→0.85vw——「工作区已调最大还不让调」解除
  function applyW(w) { root.style.width = clampW(w) + "px"; }
  function readW() {
    const v = Number(localStorage.getItem(W_KEY));
    return Number.isFinite(v) && v >= 340 ? clampW(v) : 440; // 缺省 440（WorkBuddy 同构）；旧记忆 <340（38%/280 时代）归一
  }
  // ---------- W-FZONE-R5：真第四列——桌面壳呼出=窗口外扩（chat 列宽恒不变） ----------
  // 用户 1115 五轮定谳（#167）：「在整个软件面板最右侧多出第四列，主面板变大不受压缩」——
  // 壳内（Tauri/Nova 双壳同源）呼出工作区时窗口右向外扩 sash+面板宽：三列布局容器随之变宽，
  // fzone/sash 吃掉全部增量，chat 列（flex:1，宽=shell−4−F）净变 0px。外扩梯子：屏缘余量够→
  // 直接长宽；不够→窗口先左移补位（chat 恒不变优先）；仍不够→允许右缘溢出屏（用户可拖回），
  // 绝不回头压缩 chat。最大化/全屏窗不可外扩→回落 R4 页内挤压护栏（availMax/CHAT_FIT=chat≥442
  // 下限——任务书「护栏语义=下限而非被挤目标」；浏览器/无壳同款回落=现行形态零回归）。窗口
  // 操作全走 winOp 串行链（开合/拖拽 setSize 竞态收口）。NARROW_W 自动收起链零触碰。
  const TAU = () => { const t = window.__TAURI__; return t && t.window && typeof t.window.getCurrentWindow === "function" ? t : null; };
  function shellWin() {
    const t = TAU(); if (!t) return null;
    try {
      const w = t.window.getCurrentWindow();
      return w && typeof w.setSize === "function" && typeof w.outerSize === "function" && typeof w.outerPosition === "function" ? w : null;
    } catch (_) { return null; }
  }
  const SHELL_MIN_WIN = 1200; // mac conf minWidth（Windows conf=960——JS 地板取严平台最大值；Windows 960-1199 冷载手动开面为 R4 既有行为，R5-R1 P3 注释对齐）——缩窗下限（OS 侧同拦双保险；收合压到下限时 chat 只多不少）
  // R5-R1 P0（review2 实锤）：currentMonitor 是 **模块级函数**（tauri-2.11.5 bundle.global.js
  // 实核——getCurrentWindow() 返回的 Window 实例 56 个 async 方法里无 currentMonitor，全 bundle
  // 仅 __TAURI__.window.currentMonitor 一处）——在 Window 实例上取该方法在真实壳必抛
  // TypeError→catch→false：外扩整链哑火（呼出=R4 挤压复现）而 shrink 照跑=开收循环净缩窗。模块级取用。
  const monOf = async (t) => { try { return t && t.window && typeof t.window.currentMonitor === "function" ? await t.window.currentMonitor() : null; } catch (_) { return null; } };
  const lsize = (t, w, h) => (t.dpi && typeof t.dpi.LogicalSize === "function") ? new t.dpi.LogicalSize(w, h) : { width: w, height: h }; // 平面对象兜底=v2 api 构造器同解析形（bundle.global.js 实核：1 参对象 {width,height} 判 Logical）
  const ppos = (t, x, y) => (t.dpi && typeof t.dpi.PhysicalPosition === "function") ? new t.dpi.PhysicalPosition(x, y) : { x: x, y: y };
  let winOpQ = Promise.resolve();
  let winOpUntil = 0; // R6③：winOp 窗口操作的时间窗（链头开 4s + 链尾续 700ms 迟到事件豁免）——期间到达的 resize 不清开区账（grow/shrink 的 setSize 必触发 resize；布尔标志会漏迟到事件——finally 复位后事件才到=误清）
  const winOp = (fn) => { winOpQ = winOpQ.then(() => { winOpUntil = Date.now() + 4000; }).then(fn).catch(() => {}).then((v) => { winOpUntil = Math.max(winOpUntil, Date.now() + 700); return v; }); return winOpQ; }; // R6-R2 P1（常规审查 fake-shell 实测）：链尾必须 return v——无 return 则 resolve 值恒 undefined，调用方 .then((grew)=>!grew&&applyW) 会在**成功**开区后照跑=面板被弹回记忆宽（755→440 实录）；catch→undefined 语义保留（真失败仍回落）
  function clampShellW(w) { return Math.max(340, Math.min(1200, Math.round(w))); } // 壳模式宽钳：只受面板档位界 [340,1200]（W-UIB0 上限放档；屏缘由外扩梯子消化，不受视口内 avail 钳——外扩后 avail 恒富余）
  function readWShell() { const v = Number(localStorage.getItem(W_KEY)); return Number.isFinite(v) && v >= 340 ? clampShellW(v) : 440; } // 壳模式记忆读口（缺省 440 同 readW 口径）
  let lastGrowShift = null; // R5-R1 P2-5：grow 左移量记账（{fromX, y, shift}）——shrink 后回移窗位（开移 N 收回 N 净零，贴右缘钉死态收敛：不再每开重溢 144-244px）；回移前读现位幂等守卫（用户已手动挪窗则不回移）
  // ---------- W-FZONE-R6（1116 用户两条）：开区混合外扩（chat 可让位）+sash 纯占比拖动 ----------
  // 病根同源：R5「chat 恒不变」教条在屏满态（窗≈屏宽）两头堵死——外扩容量 0→面板恒记忆宽
  // 偏窄（文件阅读体验差）+sash 拖宽被 maxGrow 钳死（拖不动）。用户拍板：开工作区可适当压缩
  // 消息面板；分隔线拖动=调占比。模型三件：
  // ①开区宽账：wt=clamp(w0+max(0,chat0-CHAT_COMFORT))——chat 超 CHAT_COMFORT 的部分本就是
  //   阅读列两侧空白（centercol v2 消息列 max(900px,…) 居中），让给工作区零视觉损；窗宽目标
  //   winT=min(winL+4+wt, maxWinL)（屏内可容纳最大窗宽=max(窗现宽, 屏宽)——永不溢出屏，R5
  //   「允许溢出+用户拖回」烂体验根除）；外扩不足的缺口转嫁压 chat（下限 CHAT_FIT 互钳，
  //   再不够砍 wt 下限 340）。CHAT_COMFORT=900=centercol 阅读列基准宽。
  // ②sash 拖动=纯占比（窗口尺寸不动）：拖宽压 chat/拖窄还 chat，clampW 的 availMax 护栏（=
  //   chat≥CHAT_FIT 视口实算）天然承载互钳——壳内窗宽=视口宽恒成立，壳/无壳两分支合一（R5
  //   的 drag 对象/push/rAF 追平整段外扩拖动逻辑退役）。
  // ③收合=按「开前窗宽快照」缩回（openFromW 记账，反方审 P1-a）：缩量=max(0,现宽−openFromW)——
  //   手动改窄→0=不动窗（保持用户手动态）；无账（丢账路径）→0 最保守（**不再**回落「4+面板宽」
  //   ——R6 下面板宽≫窗增量，该公式必超缩窗至 SHELL_MIN 地板）。账本失效判定=winOp 时间窗+
  //   expectedW echo 对账（resize 比对 |现宽−最近 setSize 目标|>2 才清——时间窗盲区内的真改窗
  //   也能被 echo 抓到，纯时间窗 4s 内改窗漏网为 P2 备案）。grow 不可外扩（最大化/通道断）→
  //   无账（收合缩 0 不动窗）+调用方 applyW 回落挤压护栏（P1-b 合同接线）。
  const CHAT_COMFORT = 640; // W-UIB0（1117 用户实锤「消息面板太宽而工作区太窄」）：开区压缩目标 900→640——阅读列舒适带下沿（消息列 max(900) 居中显示不动，仅开工作区时让出两侧空白）；CHAT_FIT=442 仍是硬下限（互钳口径）
  let chatBase = null; // 开区时刻 chat 列宽（收合还原基准）；null=无账
  let openFromW = null; // 开区**前**窗宽快照（logical；收合缩量锚=max(0,现宽−此值)）；null=无账
  let expectedW = null; // 最近一次 winOp setSize 目标宽（logical；resize echo 对账锚——偏差>2=用户真改窗）
  function chatColW() { const c = document.querySelector("#d-session .session-detail"); return c ? Math.round(c.getBoundingClientRect().width) : 0; }
  function shellOpenGrow(w0, chat0) { // R6 开区混合外扩（w0=记忆宽；chat0=**fzone 仍 hidden 期的 chat 列宽**——必须由调用方同步段量入参：winOp 异步执行时面板已 hidden=false+预置宽占位，自量恒失真=富余让位永不生效+wtMax 双扣压细条（反方审 P0））；resolve false=不可（无壳/最大化/全屏/通道断）→调用方回落挤压护栏
    return winOp(async () => {
      const t = TAU(), win = shellWin();
      if (!t || !win) return false;
      try {
        if (await win.isMaximized() || await win.isFullscreen()) { chatBase = null; openFromW = null; return false; } // 未动窗=无账（收合缩 0）；挤压护栏回落归调用方（P1-b）
        const scale = await win.scaleFactor();
        const o = await win.outerSize(), p = await win.outerPosition(); // physical（屏缘 room/窗位系——outer 才是窗物理全幅）
        const iw = await win.innerSize(); // R5-R1 P1-b：宽账读 inner 写 inner 对称（set_size→set_inner_size——Windows decorations:true 外框不进账，每开收循环 +2b≈+28-32px 膨胀链根除；Mac/Nova outer=inner 零影响。顺刀：目标高也改 inner 高——旧码把 outer 高（含 titlebar）写进 inner 高的隐患同根消除）
        const mon = await monOf(t); // R5-R1 P0：模块级（实例法在真壳必抛=外扩哑火主根）
        const winL = Math.round(iw.width / scale);
        const other = winL - chat0; // 开前窗内其他列+chrome 合计（chat0=hidden 期入参——fzone 关着无 sash，开区后恒等式 chat=winT-other-4-wt）
        let wt = Math.max(340, Math.min(1200, Math.round(w0 + Math.max(0, chat0 - CHAT_COMFORT)))); // ①chat 空白富余让给工作区（W-UIB0 上限 1200）
        let winT = Math.min(winL + 4 + wt, Math.max(winL, mon ? Math.floor(mon.size.width / scale) : winL)); // 屏满钳（mon 缺失=零外扩纯压缩，不溢出屏）
        const wtMax = Math.round(winT - other - 4 - CHAT_FIT); // chat 硬下限互钳
        if (wt > wtMax) { wt = Math.max(340, wtMax); winT = Math.min(winL + 4 + wt, winT); } // 砍 wt 后 winT 只减不增（外扩需求同步少）
        root.style.width = wt + "px";
        const room = mon ? mon.position.x + mon.size.width - (p.x + o.width) : Infinity; // 右缘屏内余量（physical；mon 缺失=Infinity→不左移）
        const overPhys = Math.round((winT - winL) * scale) - room; // 右缘溢出量（physical）
        if (overPhys > 0 && winT > winL && p.x > (mon ? mon.position.x : 0)) { // 左移补位（P2-6 负坐标域；反方审场景5：winT>winL 门=零增长不位移——跨屏窗 monW<winL 态 overPhys 恒正会白瞬移窗贴 mon 左缘且收合不回位）
          const shift = Math.min(p.x - mon.position.x, overPhys);
          await win.setPosition(ppos(t, p.x - shift, p.y));
          lastGrowShift = { fromX: p.x, y: p.y, shift }; // P2-5 收合回移记账
        } else lastGrowShift = null;
        await win.setSize(lsize(t, winT, iw.height / scale));
        expectedW = winT; // echo 对账锚
        chatBase = chat0; openFromW = winL; // ③收合账本（开前快照）
        return true;
      } catch (_) { chatBase = null; openFromW = null; return false; }
    });
  }
  function shellShrink(pxL) { // 收合缩回：pxL=窗宽缩量（logical——主调方按 openFromW 账传 max(0,现宽−开前宽)，无账传 0）；压到 SHELL_MIN_WIN 时 OS 拦=chat 只多不少
    return winOp(async () => {
      const t = TAU(), win = shellWin();
      if (!t || !win) return;
      try {
        if (await win.isMaximized() || await win.isFullscreen()) { // R5-R1 P1-a：最大化/全屏态禁缩（tao set_inner_size 会把 zoomed 窗拉出最大化——review2 C12 实测 2560→2116）
          lastGrowShift = null; chatBase = null; openFromW = null; // W-P3SWEEP N1 同源：早退清账——窗位/开区语境已失效
          return; }
        const scale = await win.scaleFactor();
        const iw = await win.innerSize(); // R5-R1 P1-b：宽账读 inner（与 grow 对称）
        const target = Math.max(SHELL_MIN_WIN, (iw.width - Math.round(pxL * scale)) / scale);
        if (target < iw.width / scale) { await win.setSize(lsize(t, target, iw.height / scale)); expectedW = target; }
        // 反方审场景5：缩量 0（早退）也走回移+清账——grow 期跨屏瞬移的回位出口（旧码早退 return 跳过回移=瞬移永久化+账悬挂）
        if (lastGrowShift) { // R5-R1 P2-5：grow 左移的回移（开移 N 收回 N 净零——贴右缘/钉死态每开重溢收敛）；现位守卫=用户已挪窗则放弃
          try {
            const p2 = await win.outerPosition();
            if (p2.x === lastGrowShift.fromX - lastGrowShift.shift) await win.setPosition(ppos(t, lastGrowShift.fromX, lastGrowShift.y));
          } catch (_) {}
          lastGrowShift = null;
        }
        chatBase = null; openFromW = null; // 账随收合终结（下次开区重记）
      } catch (_) {}
    });
  }
  function setOpen(on) {
    // W-P3SWEEP N2 备案（1115 R5 复核·观感项·不动逻辑）：下方 grow 为 await win.setSize 异步
    // 落地——落地前一拍 chat 列已被 flex 预让位（面板 DOM 先 hidden=false 占宽），瞬时低于
    // CHAT_FIT 护栏数十 ms 后回弹（grow 到位=chat 恢复）。pre-apply 最小面板宽可消此拍但引入
    // 宽度抖动双形态——按审查口径注释备案+装机轮观察，真机可感知再议。
    const wasOpen = !root.hidden;
    if (on && !wasOpen && shellWin()) { // R5 真第四列：壳内呼出=窗口外扩（R6：外扩优先+chat 压缩补足——见 shellOpenGrow 头注）。!wasOpen 门=已开时重复 setOpen(true)（open() 点文件聚焦路径）不二次外扩
      const w0 = readWShell();
      const chat0 = chatColW(); // 反方审 P0：chat0 必须在 fzone 仍 hidden 的同步段量（winOp 异步执行时面板已 hidden=false+预置宽占位——自量=账锚失真：富余让位永不生效+wtMax 双扣把面板压成 340 细条）
      root.style.width = Math.max(340, Math.min(1200, Math.round(w0 + Math.max(0, chat0 - CHAT_COMFORT)), Math.round(window.innerWidth) - 4 - CHAT_FIT)) + "px"; // R6：同步先落「chat 空白富余已让」的目标宽（winOp 内互钳后可能再收窄——一拍微调可接受，方向一致不闪跳；W-UIB0 上限 1200）。审查 P3 修（预压钳）：CSS 上限放档后本拍瞬时目标宽不再被 800 意外兜住——加当前视口几何钳（chat≥CHAT_FIT；winOp 落地后终钳，防数十 ms 破底闪拍；Math.max 340 外兜=极窄视口不塌细条）
      shellOpenGrow(w0, chat0).then((grew) => { if (!grew) applyW(readW()); }); // P1-b：不可外扩回落挤压护栏接线（最大化/全屏/通道断——availMax/CHAT_FIT 护栏口径，头注合同兑现）
    } else if (on) applyW(readW()); // R4 P1-2 修（审 B）+ R4-R1 刀三合流单点：展开时按当前视口重钳记忆宽（护栏保对话列/composer 全按钮——窄域手动再开不再 215px 细条；记忆 800 极窄再开被 avail 收紧）——open/toggle/autoOpen 全走本口（R5/R6：无壳回落同口）
    else if (!on && wasOpen && shellWin()) shellShrink(openFromW != null ? Math.max(0, Math.round(window.innerWidth) - openFromW) : 0); // R6③：收合缩量=现宽−开前快照（手动改窄→0=保持用户态；无账→0 最保守不动窗——反方审 P1-a：旧「4+面板宽」回落在 R6 下面板宽≫窗增量必超缩）
    root.hidden = !on;
    root.classList.toggle("open", on);
    const sash = document.querySelector("#d-session .fz-sash");
    if (sash) sash.hidden = !on; // sash 随面板开合（WorkBuddy：面板关=整组不渲染，我方 hidden 等价）
    // W-UIP2 件二（1115 test.18 PM 定案）：窄窗(<NARROW_W)策略反转——不收 fzone 收列表：
    // 开面板时窄窗→会话列表自动让位（.queue.fz-yield）+一次性 toast；关面板→本次系自动
    // 让位才还原（autoYielded 记账——用户手动收过列表的不抢）。「⟨ 列表」呼出钮见 renderTools。
    if (on && window.innerWidth < NARROW_W) yieldQueue(true, true);
    if (!on && autoYielded) yieldQueue(false, false);
    // R4：旧 fz-on 类随 session-split 退役删除（CSS 全仓零消费=vestigial）
    // 头部常驻开关钮状态回显（面板收起后=唯一再展开入口——静态 conv-mini 钮，data-fzone-toggle 不随对话重建）
    document.querySelectorAll("[data-fzone-toggle]").forEach((b) => {
      b.classList.toggle("on", on);
      b.title = "文件工作区（" + (on ? "开 · 点击收起" : "关 · 点击展开") + "）";
    });
    renderTools();
  }
  // ---------- 工具行（收起/展开 + tab 计数状态；树/diff 钮=批二占位不渲染） ----------
  function renderTools() {
    if (!toolsEl) return;
    const n = state.tabs.length;
    const freshN = state.tabs.filter((t) => t.fresh).length;
    const qEl = document.querySelector("#d-session .queue");
    const yieldBtn = qEl && qEl.classList.contains("fz-yield") ? '<button type="button" class="fz-tool" data-fz-recall-queue title="呼出会话列表（窄屏自动收起让位）">☰ 列表</button>' : "";
    toolsEl.innerHTML = '<button type="button" class="fz-tool" data-fz-collapse title="' + (root.hidden ? "展开文件工作区" : "收起文件工作区（保留全部 tab）") + '">' + (root.hidden ? "⟨ 展开" : "收起 ⟩") + "</button>" + yieldBtn +
      '<button type="button" class="fz-tool" data-fz-tree-btn title="工作空间树（本会话产物按目录分组）">▤ 树</button>' +
      '<span class="fz-spring"></span><span class="fz-state">' + (n ? n + " tab" + (n > 1 ? "s" : "") + (freshN ? ' · <b class="fz-freshn">' + freshN + " 新</b>" : "") : "空") + "</span>";
  }
  // ---------- tab 渲染 ----------
  function baseName(p) { return String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || ""); }
  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.innerHTML = state.tabs.map((t) =>
      '<button type="button" class="wtab' + (t.id === state.active ? " on" : "") + '" data-fz-tab="' + esc(t.id) + '" title="' + esc(t.path) + '" role="tab" aria-selected="' + (t.id === state.active ? "true" : "false") + '">' +
      '<span class="fic">' + iconHtml(baseName(t.path)) + "</span>" +
      '<span class="fname">' + esc(baseName(t.path)) + "</span>" +
      (t.fresh ? '<span class="fz-badge" title="本回合新增">新</span>' : "") +
      '<span class="x" data-fz-close="' + esc(t.id) + '" role="button" aria-label="关闭 ' + esc(baseName(t.path)) + '" title="关闭">✕</span>' +
      "</button>").join("") || '<span class="fz-tabs-empty">尚无打开的文件</span>';
  }
  function renderBodies() {
    if (!bodyEl) return;
    const hint = bodyEl.querySelector("[data-fz-empty]");
    if (!state.tabs.length) { // 空态（任务书三态齐）：单例提示卡（无 tab 才在场——CDP 截图实锤：fz-fb display:flex 压过 [hidden]，故提示卡走移除制不走隐藏制）
      if (!hint) { bodyEl.innerHTML = '<div class="fz-fb" data-fz-empty><span>空 · 点消息里的文件、产物行或头部「▤ 工作区」展开</span></div>'; }
      return;
    }
    if (hint) hint.remove();
    [...bodyEl.children].forEach((c) => { c.hidden = c.dataset.fzPane !== state.active; });
  }
  function renderAll() { renderTabs(); renderBodies(); renderTools(); }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]); }

  // ---------- 开 tab（同文件重开=聚焦不重复——任务书铁则；W-FZONE-B1-R1 P2-①：tab 挂会话作用域） ----------
  function tabId(sid, path) { return String(sid) + "\u0001" + String(path); } // 复合 id：跨会话同名路径=不同 tab（宁可开双 tab 不串内容——审修定谳口径）
  function open(sid, path) {
    const p = String(path || "");
    if (!p) return;
    state.lastSid = String(sid);
    const id = tabId(sid, p);
    const hit = state.tabs.find((t) => t.id === id);
    if (hit) { hit.fresh = false; state.active = id; renderAll(); return; } // 聚焦已有 tab（复合 id=同会话同路径才命中，跨会话串台不可能；聚焦即清「新」角标）
    const pane = document.createElement("div");
    pane.className = "fz-pane";
    pane.dataset.fzPane = id;
    pane.innerHTML = '<div class="fz-load">拉取中…</div>';
    bodyEl.appendChild(pane);
    panes.set(id, pane); // W-FZONE-R2：pane 登记入跨会话保活表（detach/stash 恢复链一致）
    state.tabs.push({ id, path: p, sid: String(sid) }); // P2-①：tab 自带 sid（retry 不再依赖全局单值）
    state.active = id;
    setOpen(true);
    renderAll();
    load(id, pane, sid, p);
  }
  // ---------- W-FZONE-B2 件②：产物自动推 tab（回合收口新增 artifacts——session-domain
  // fzAutoTabOnUpdate 差分调这里）：不抢焦点（state.active 不动——用户正在看的 tab 不切）+
  // 「新」角标（点击聚焦即清）。面板收起时不强行展开（不打扰）：tab 静默入列，工具行计数带
  // 「N 新」，用户展开即见。已开过的文件重复新增=只补角标不开新 tab。
  function autoOpen(sid, path) {
    const p = String(path || "");
    if (!p) return;
    state.lastSid = String(sid);
    const id = tabId(sid, p);
    const hit = state.tabs.find((t) => t.id === id);
    if (hit) { if (!hit.fresh) { hit.fresh = true; renderTabs(); renderTools(); } return; }
    const pane = document.createElement("div");
    pane.className = "fz-pane";
    pane.dataset.fzPane = id;
    pane.innerHTML = '<div class="fz-load">拉取中…</div>';
    bodyEl.appendChild(pane);
    panes.set(id, pane); // W-FZONE-R2：同 open——pane 保活登记
    state.tabs.push({ id, path: p, sid: String(sid), fresh: true });
    if (!state.active) state.active = id; // 面板空态首 tab：自然成为 active（无焦点可抢）
    renderAll(); // 面板收着也渲染（hidden 容器内零视觉；展开即见）
    load(id, pane, sid, p);
  }
  function load(id, pane, sid, path) { // path 独立参数（P2-① 复合 id 不再等价 path——挂口第三参须传真路径）
    const fn = loadFn();
    if (!fn) { pane.innerHTML = errCard("内容加载器未就绪（session 域未挂载）", id); return; }
    Promise.resolve().then(() => fn(pane, sid, path)).catch((e) => { pane.innerHTML = errCard(String((e && e.message) || e), id); });
  }
  function errCard(msg, id) {
    return '<div class="fz-fb"><span class="fz-fb-ico">✕</span><span>拉取失败：' + esc(String(msg).slice(0, 160)) + '</span><button type="button" class="secondary-btn" data-fz-retry="' + esc(id) + '">重试</button></div>';
  }
  // ---------- 关 tab（关最后一个=面板收起，状态记忆） ----------
  function unloadPane(pane) { // P2-②：pane 资源回收委托 session-domain 挂口（per-tab blob url revoke——本文件零数据面原则不变）
    const un = window.__ccDeck005FzoneUnload;
    if (pane && typeof un === "function") { try { un(pane); } catch (_) {} }
  }
  function close(id) {
    const i = state.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    state.tabs.splice(i, 1);
    const pane = bodyEl.querySelector('[data-fz-pane="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (pane) { unloadPane(pane); pane.remove(); }
    panes.delete(id); // W-FZONE-R2：关 tab 即真释放（保活表同步清——不占 stash 额度）
    if (state.active === id) state.active = state.tabs[Math.min(i, state.tabs.length - 1)]?.id ?? null;
    if (!state.tabs.length) { setOpen(false); state.active = null; renderAll(); return; }
    renderAll();
  }
  // 切会话暂存/恢复（W-FZONE-R2，1111 用户实锤「按 WorkBuddy 的开发」：右侧分栏常驻——
  // 切会话工作区不消失，tab 内容按会话隔离保留）。前身=B1-R1 P2-①「切会话清空」（防跨会话
  // 串台+retry 错拉）；R2 升格为 per-sid 暂存：切走=快照（tabs+active+pane DOM detach 保活——
  // blob/iframe 零重载），切回=原样恢复。防串台语义不降级：恢复的 tab 各带原 sid（retry 仍
  // 用 tab.sid——复合 id 天然不串）。lastSid 幂等守卫沿用（同 sid 重入零动作）。
  // stash LRU 上限 8 会话：超出淘汰最旧（unloadPane 释放 blob/iframe——防长会话漂移内存膨胀）。
  // 树抽屉不暂存（数据源随会话失效，切回按需重开）；开合态不动。
  function detachPanes() { [...bodyEl.querySelectorAll("[data-fz-pane]")].forEach((p) => { panes.set(p.dataset.fzPane, p); p.remove(); }); }
  function restorePanes(sid) {
    const keep = new Set(state.tabs.map((t) => t.id));
    for (const t of state.tabs) {
      const p = panes.get(t.id);
      if (p) bodyEl.appendChild(p); // 原 pane 原样回挂（内容/blob 保活零重拉）
      else { // 兜底重建（stash 淘汰过的会话 tab 仍在 tabs 快照里=只重建壳重载内容）
        const np = document.createElement("div");
        np.className = "fz-pane";
        np.dataset.fzPane = t.id;
        np.innerHTML = '<div class="fz-load">拉取中…</div>';
        bodyEl.appendChild(np);
        load(t.id, np, t.sid, t.path);
      }
    }
    // R2-R1（双审 P2 定谳）：本函数零释放——panes=全 stash 会话 pane 池（目标会话不引用的
    // 他 sid pane 留池保活），释放归两路独占：closeTab（unloadPane+panes.delete）/stashEvict
    //（LRU 淘汰 unloadPane+delete 双连）。原「尾清理循环」裸 delete 绕过 unloadPane（图片
    // blob 不 revoke 泄漏）+他 sid pane 误删（B→A→B 切回必兜底重载=保活名存实亡）——已删。
  }
  function stashEvict() {
    while (stash.size > STASH_MAX) {
      const oldest = stash.keys().next().value; // Map 插入序=LRU（恢复命中时重插见下）
      const snap = stash.get(oldest);
      stash.delete(oldest);
      for (const t of snap.tabs) { const p = panes.get(t.id); if (p && !p.isConnected) { unloadPane(p); panes.delete(t.id); } } // 淘汰会话的离场 pane 真释放
    }
  }
  function resetForSession(sid) {
    const s = String(sid || "");
    if (s === state.lastSid) return;
    if (state.lastSid && state.tabs.length) {
      stash.delete(state.lastSid); // LRU 触顶：重插刷新热度
      stash.set(state.lastSid, { tabs: state.tabs, active: state.active });
      stashEvict();
    }
    state.lastSid = s;
    closeTree(); // 树抽屉随会话清空（数据源已随会话切换失效；不暂存）
    detachPanes();
    const snap = stash.get(s);
    if (snap) {
      state.tabs = snap.tabs;
      state.active = snap.active;
      restorePanes(s);
    } else {
      state.tabs = [];
      state.active = null;
    }
    renderAll();
  }
  function retry(id) {
    // 兼容两卡源：fzone errCard（加载器未就绪）带复合 id / session-domain fzFb（拉取失败）带纯 path
    const t = state.tabs.find((x) => x.id === id) || state.tabs.find((x) => x.path === id);
    if (!t) return;
    const pane = bodyEl.querySelector('[data-fz-pane="' + (window.CSS && CSS.escape ? CSS.escape(t.id) : t.id) + '"]');
    if (!pane) return; // P2-①：retry 取 tab 自带 sid（旧全局 state.sid 已除——跨会话错拉不可能）
    pane.innerHTML = '<div class="fz-load">拉取中…</div>';
    load(t.id, pane, t.sid, t.path);
  }

  // ---------- W-FZONE-B2 件③：工作空间树抽屉（降级形态：已登记产物按目录分组——relay 无
  // 列目录命令，任务书预判降级；数据源=window.__ccDeck005FzoneArts（session-domain 当前会话
  // artifacts 原文路径）；点击走 OpenByToken（原文 path 直命中 openFzoneTab）。懒加载口径：
  // 首次点击「▤ 树」才拉数据渲染（产物多时也只渲一屏列表+目录分组，无递归展开成本）。
  let treeEl = null;
  function dirOf(p) { const seg = String(p || "").replace(/[\\/]+$/, "").split(/[\\/]/); seg.pop(); return seg.join("/"); }
  function renderTree() {
    closeTree();
    const arts = (typeof window.__ccDeck005FzoneArts === "function" ? window.__ccDeck005FzoneArts() : null) || [];
    const groups = new Map(); // dir → [name]
    for (const a of arts) {
      const d = dirOf(a.path) || "（根）";
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(baseName(a.path));
    }
    const rows = [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([d, names]) =>
      '<div class="fz-tree-dir">' + esc(d) + "</div>" +
      names.sort().map((n) => '<button type="button" class="fz-tree-file" data-fz-tree-open="' + esc(d === "（根）" ? n : d + "/" + n) + '"><span class="fic">' + iconHtml(n) + "</span>" + esc(n) + "</button>").join("")
    ).join("");
    treeEl = document.createElement("div");
    treeEl.className = "fz-tree";
    treeEl.dataset.fzTree = "1";
    treeEl.innerHTML = '<div class="fz-tree-head"><span>工作空间 · ' + arts.length + " 件产物</span><button type=\"button\" class=\"fz-tool\" data-fz-tree-close title=\"关闭树\">✕</button></div>" +
      '<div class="fz-tree-list">' + (rows || '<div class="fz-tree-empty">本会话暂无登记产物——产物由 deliver/输出物链登记</div>') + "</div>" +
      '<div class="fz-tree-note">降级形态：按已登记产物目录分组（目录浏览需 relay 列目录通道，批三评估）</div>';
    bodyEl.appendChild(treeEl);
  }
  function closeTree() {
    if (treeEl && treeEl.isConnected) treeEl.remove();
    treeEl = null;
  }

  // ---------- 事件（tab 切换/关闭/中键关/重试/收起/拖宽/树/⌘1-8） ----------
  root.addEventListener("click", (ev) => {
    const x = ev.target.closest("[data-fz-close]");
    if (x) { ev.stopPropagation(); close(x.dataset.fzClose); return; }
    const tb = ev.target.closest("[data-fz-tab]");
    if (tb) {
      state.active = tb.dataset.fzTab;
      const cur = state.tabs.find((t) => t.id === state.active);
      if (cur && cur.fresh) cur.fresh = false; // 点击聚焦清「新」角标
      closeTree();
      renderAll();
      return;
    }
    const rt = ev.target.closest("[data-fz-retry]");
    if (rt) { retry(rt.dataset.fzRetry); return; }
    // md 预览体内的路径 token（mdHtml 同款 .fpath）→ 经 session-domain 登记面解析开新 tab
    const fp = ev.target.closest(".fpath[data-p]");
    if (fp && typeof window.__ccDeck005FzoneOpenByToken === "function") { window.__ccDeck005FzoneOpenByToken(fp.dataset.p); return; }
    const co = ev.target.closest("[data-fz-collapse]");
    if (co) { setOpen(root.hidden); return; }
    // W-UIP2 件二：列表呼出钮（yield 态在场）——用户主动呼出=让位记账清零（此后 fzone 收起不再自动还原抢意愿）
    if (ev.target.closest("[data-fz-recall-queue]")) { yieldQueue(false, false); return; }
    // W-FZONE-B2 件③：树抽屉（钮=开/关切换；树内文件=OpenByToken 路由开 tab；树外点击=收树）
    if (ev.target.closest("[data-fz-tree-close]")) { closeTree(); return; }
    const tf = ev.target.closest("[data-fz-tree-open]");
    if (tf) {
      if (typeof window.__ccDeck005FzoneOpenByToken === "function") window.__ccDeck005FzoneOpenByToken(tf.dataset.fzTreeOpen);
      closeTree();
      return;
    }
    if (ev.target.closest(".fz-tree")) return; // 树体内部其余点击不动作
    if (ev.target.closest("[data-fz-tree-btn]")) { if (treeEl) closeTree(); else renderTree(); return; }
    if (treeEl) closeTree(); // 树外点击收树
  });
  root.addEventListener("auxclick", (ev) => { // 中键关闭（spec 交互流）
    if (ev.button !== 1) return;
    const tb = ev.target.closest("[data-fz-tab]");
    if (tb) { ev.preventDefault(); close(tb.dataset.fzTab); }
  });
  // W-FZONE-B2 件⑤（批一 P3 随批）：⌘/Ctrl+1..8 直达第 N tab（Nova/WKWebView 壳内生效——
  // 桌面浏览器 ⌘1-8 系浏览器 tab 切换保留键，页面层 preventDefault 抢不到属预期，回执声明）
  document.addEventListener("keydown", (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    const n = parseInt(ev.key, 10);
    if (!(n >= 1 && n <= 8) || !state.tabs.length || root.hidden) return;
    const t = state.tabs[n - 1];
    if (!t) return;
    ev.preventDefault();
    t.fresh = false;
    state.active = t.id;
    closeTree();
    renderAll();
  });

  // 头部常驻开关钮（会话 head-actions 静态位——面板收起后唯一再展开入口；委托监听不依赖面板可见）
  document.addEventListener("click", (ev) => {
    const tg = ev.target.closest("[data-fzone-toggle]");
    if (tg) { ev.preventDefault(); setOpen(root.hidden); }
  });
  // W-FZONE-R3：拖拽柄=会话面板外的窗口级 sash（.fz-sash——WorkBuddy __detail-sash 形态）；
  // 算法 WorkBuddy 同构：mousedown 记 startX/startWidth → move=startWidth+(startX-clientX)（右锚定，
  // 向左拖=加宽）→ clamp → up 摘监听+解锁 body cursor/userSelect（拖拽全程全局锁 col-resize
  // 光标+禁文本选择——WorkBuddy onMouseUp 同款）。pointer capture 版实现（Nova/WKWebView
  // 兼容性优于 document mousemove 挂摘）。
  // W-FZONE-R6②：sash 拖动=纯占比调整（窗口尺寸不动）——拖宽压 chat/拖窄还 chat，chat 与 fzone
  // 此消彼长（用户 1116「分隔线支持左右拖动调整占比」字面语义）。壳内窗宽=视口宽恒成立，
  // clampW 的 availMax 护栏（=chat≥CHAT_FIT 视口实算）天然承载 chat 硬下限互钳，壳/无壳两
  // 分支合一（R5 的外扩拖动 drag 对象/push/rAF 追平整段退役——外扩只发生在开/收两刻）。
  const rz = document.querySelector("#d-session .fz-sash[data-fz-resize]");
  if (rz) {
    rz.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const startX = ev.clientX, startW = root.getBoundingClientRect().width;
      try { rz.setPointerCapture(ev.pointerId); } catch (_) {} // capture 成功则 move/up 路由到 rz；合成输入/部分 WebView 不路由——document 双保险挂摘兜底（同 clientX 双跑幂等）
      rz.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const move = (e2) => { applyW(startW + (startX - e2.clientX)); }; // R6：纯占比（clampW 护栏=chat≥CHAT_FIT+档位 [340,800]；窗口不动）
      const up = () => {
        rz.removeEventListener("pointermove", move); rz.removeEventListener("pointerup", up); rz.removeEventListener("pointercancel", up);
        document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up);
        rz.classList.remove("dragging");
        document.body.style.cursor = ""; document.body.style.userSelect = "";
        try { localStorage.setItem(W_KEY, String(clampW(root.getBoundingClientRect().width))); } catch (_) {} // 记忆=拖后现宽（clampW 口径——下次开区由 shellOpenGrow 按窗几何重算互钳）
      };
      rz.addEventListener("pointermove", move); rz.addEventListener("pointerup", up); rz.addEventListener("pointercancel", up); // 反方审 P2：pointercancel（触控板系统手势抢断）同口清理——R5 监听只在 rz 悬挂无害，R6 挂 document 后悬挂=全窗口任意移动都在改宽+光标卡死
      document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); // R6 探针实锤：CDP/WKWebView 边缘态 pointer capture 不路由=move 失联拖不动——document 挂摘双保险（capture 路由时事件仍冒泡至 document，双跑同参幂等；up 双摘防悬挂）
    });
  }

  // ---------- 启动：冷启必收起（W-FZONE-R4） ----------
  // R3 及以前：OPEN_KEY 记忆上次开合、冷启自动恢复展开——用户实锤「空面板每次冷启复活=切不掉」
  // 病灶根除：内容 tab 本就不跨启持久，空面板冷启零价值。OPEN_KEY 全退役（读写双点）——
  // R4 冷启必收起后零消费者，P2 批五清账（R4 批曾自认「写点保留」，本批终清）。
  // 开合仍记忆，不回灌冷启）；用户开文件/点头部钮才展开。
  applyW(readW());
  renderAll();

  // ---------- W-FZONE-R4：极窄自动收起（NARROW_W 单向）；R4-R1 刀二/刀三增强 ----------
  // 跨入窄域边沿且面板开→收起（tab 保留不丢；跨出不回弹的实际保障=下方「跨出边沿无动作」
  // 分支——原 remember 写入无消费者已随 P2 批五 OPEN_KEY 清账删除）；
  // 窄域内 resize 不动作（用户头部钮手动再开不抢）；冷启必收起故载入态无面板可收（wasNarrow
  // 初始化即载入判定）。窄窗任何宽度面板都是真实列（R4 浮层形态已删，永不盖对话/输入框）。
  // R4-R1 刀二（审二第五轮直答①/P2-②）：NARROW_W 1000→1200——1000-1199「细条可用」带（对话列
  // 191-291px+按钮溢出）正是用户主诉「工作区开着对话挤成缝」，跨入即收；自动收起复用 B4 toast
  // 通道示众（静默再收=审二实录病——「我自己开的拖下窗口就没了」），仅自动收起边沿弹（手动
  // 收/开、跨出窄域不弹）。
  // 1200=939-1071 备案带外沿+composer 全按钮零溢出实测下界（R4-R1 九档扫描 ≥1071）
  // NARROW_W 已提前定义（W-UIP2 件二——setOpen 引用域）
  let wasNarrow = window.innerWidth < NARROW_W;
  let rzTid = 0;
  window.addEventListener("resize", () => {
    // R6③：账本失效判定=winOp 时间窗 **+ expectedW echo 对账**（反方审 P1-a/P2：纯时间窗 4s 盲区内
    // 用户真改窗会漏清——echo 比对 |现宽−最近 setSize 目标|>2 才清，grow/shrink 自发的 resize 因
    // 偏差≈0 不清）；清账后收合缩量=0（不动窗保持用户手动态=安全方向）
    if (Date.now() > winOpUntil && (chatBase != null || openFromW != null) && (expectedW == null || Math.abs(Math.round(window.innerWidth) - expectedW) > 2)) { chatBase = null; openFromW = null; }
    clearTimeout(rzTid);
    rzTid = setTimeout(() => {
      const narrow = window.innerWidth < NARROW_W;
      // W-UIP2 件二反转（1115 test.18 PM 定案）：窄窗不再收 fzone——fzone 开着跨入窄域→列表
      // 让位（+toast）；跨出→本次系自动让位则还原；窄域内 resize 不重弹（wasNarrow 边沿语义）。
      if (narrow && !wasNarrow && !root.hidden) yieldQueue(true, true);
      if (!narrow && wasNarrow && autoYielded) yieldQueue(false, false);
      wasNarrow = narrow;
      // R4 P1-2 修（审 B）+ R4-R1 刀三合流：面板开着时视口变化（不跨窄域如 1200→1100，或跨出变宽）
      // 同样重钳——变窄收进 avail 护栏（1200-1399 带 800px 面板挤对话同治），变宽回弹到记忆宽
      //（readW=拖柄存值即记忆，回弹与拖柄语义一致；「只收不放」改为「收进回弹」——P1-2 只收目标
      // 由 avail 钳承载，回弹不破坏其极窄自洽：极窄再开仍被 avail 压住）。
      if (!root.hidden) applyW(readW());
    }, 120);
  });

  window.ccDeckFzone = Object.freeze({ open, autoOpen, close, resetForSession, toggle: () => setOpen(root.hidden, true), isOpen: () => !root.hidden, tabs: () => state.tabs.map((t) => t.path) }); // B2：autoOpen 入 API（session-domain 差分挂点消费）
})();
