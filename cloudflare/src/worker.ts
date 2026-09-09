// Cloudflare 形态云桥：Worker 入口只做 upgrade + token 鉴权，
// 连接全部交给唯一的 RouterDO 实例（WebSocket Hibernation API，
// 空闲时 DO 休眠不计费）。路由逻辑与 Node 形态共用
// ../../cloud-bridge/src/router.ts 的 CloudRouter，协议完全一致。
import { DurableObject } from "cloudflare:workers";
import { CloudRouter } from "../../cloud-bridge/src/router.ts";

interface Env {
  CLOUD_TOKEN: string;
  DL?: KVNamespace;
  PUBLIC_TOKEN?: string; // 可选：开源公共桥场景的公开 token（与 CLOUD_TOKEN 任一匹配即放行，连接统一受 DO 内限流保护）
  ROUTER: DurableObjectNamespace<RouterDO>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      // 转发进 DO 拿设备列表（与 Node 形态 /health 对齐；会唤醒 DO，无连接时即刻再休眠）
      const stub = env.ROUTER.get(env.ROUTER.idFromName("main"));
      return stub.fetch(new Request("https://router/health"));
    }
    // 安装包分发（/dl/<file>）：文件放 KV（ECS 镜像对 CF 境外出口 403），
    // 全程不出 Cloudflare——公司只需能开本域即可下载。文件名白名单防滥用
    if (url.pathname.startsWith("/dl/")) {
      const name = url.pathname.slice(4);
      // /dl/ 无文件名：开源项目落地页（hero / 特性 / 原理 / 下载 / 页脚，与 web 控制台同品牌 Token）。
      // 桌面端走 KV；APK 超 KV 单值 25MB 上限，指 Releases 与国内镜像
      if (name === "") {
        return new Response(
          '<!DOCTYPE html><html lang="zh-CN"><head>' +
            '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<meta name="color-scheme" content="dark"><meta name="theme-color" content="#060D16">' +
            '<meta name="description" content="CC Deck——把 Claude Code 装进口袋：在手机、网页、桌面远程完成桌面端的几乎一切——注入指令、批准权限、切换模型、跟踪任务、接收汇报，并有主动通知等随身增强，手表亦可。可自建 relay，端到端加密。">' +
            '<meta property="og:title" content="CC Deck — Claude Code 的随身控制台">' +
            '<meta property="og:description" content="不止远程查看：在手机、网页、桌面注入指令、批准权限、切换模型、跟踪任务、接收汇报——桌面端的几乎一切随身可用，手表亦可。可自建、端到端加密。">' +
            '<title>CC Deck — Claude Code 的随身控制台</title>' +
            '<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2064%2064%22%3E%3Crect%20width=%2264%22%20height=%2264%22%20rx=%2214%22%20fill=%22%23F1844F%22/%3E%3Ctext%20x=%2232%22%20y=%2244%22%20font-size=%2230%22%20font-weight=%22700%22%20text-anchor=%22middle%22%20fill=%22%231A0D06%22%3ECC%3C/text%3E%3C/svg%3E">' +
            '<style>' +
            '*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}' +
            'body{background:#060D16;color:#E5EDF7;font:15px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;min-height:100vh}' +
            'main{max-width:1160px;margin:0 auto;padding:64px 24px 40px}a{color:inherit;text-decoration:none}' +
            'svg{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}svg.st{fill:currentColor;stroke:none}' +
            'h1{font-size:36px;font-weight:800;letter-spacing:.5px;line-height:1.25}h2{font-size:21px;font-weight:700;margin:6px 0 8px}' +
            '.kicker{font-size:11.5px;font-weight:700;letter-spacing:2.5px;color:#F1844F}.lead{color:#8EA3BA;font-size:14.5px;max-width:680px}' +
            'section{margin-top:24px}.hero{text-align:center;padding-bottom:36px}' +
            '.tagline{color:#8EA3BA;font-size:16px;max-width:640px;margin:14px auto 0}' +
            '.ends{margin-top:12px;color:#53677E;font-size:13.5px;letter-spacing:2px}' +
            '.pills{display:flex;gap:8px;justify-content:center;margin-top:20px;flex-wrap:wrap}' +
            '.pill{display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 12px;border-radius:999px;background:#101D2D;border:1px solid #1D3046;color:#8EA3BA;font-size:12.5px;transition:color .12s,border-color .12s}' +
            'a.pill:hover{color:#E5EDF7;border-color:#2E4A66}.dot{width:6px;height:6px;border-radius:50%;background:#55D98A}' +
            '.cta{display:flex;gap:12px;justify-content:center;margin-top:22px;flex-wrap:wrap}' +
            '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:8px;font-weight:600;border:1px solid transparent;transition:background .12s,border-color .12s,color .12s}' +
            '.btn.pri{background:#F1844F;color:#1A0D06;height:42px;padding:0 20px;font-size:14.5px}.btn.pri:hover{background:#F6976C}' +
            '.btn.ghost{background:#101D2D;border-color:#1D3046;color:#E5EDF7;height:42px;padding:0 20px;font-size:14.5px}.btn.ghost:hover{border-color:#2E4A66;background:#12202F}' +
            '.card .pri{width:100%;min-height:38px;padding:0 12px;font-size:13px;line-height:1.4}' +
            '.card .sec{width:100%;min-height:34px;padding:0 12px;font-size:12.5px;line-height:1.4;background:transparent;border-color:#1D3046;color:#8EA3BA}.card .sec:hover{color:#E5EDF7;border-color:#2E4A66}' +
            '.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}' +
            '.feat{background:#0D1827;border:1px solid #1D3046;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;transition:border-color .12s}.feat:hover{border-color:#2E4A66}' +
            '.ic{width:34px;height:34px;border-radius:8px;background:#101D2D;border:1px solid #1D3046;display:flex;align-items:center;justify-content:center;color:#F1844F;flex:none}' +
            '.feat b{font-size:14.5px;font-weight:600}.feat p{font-size:13px;color:#8EA3BA;line-height:1.65}' +
            '.flow{display:flex;align-items:stretch;justify-content:center;gap:12px;margin-top:20px;flex-wrap:wrap}' +
            '.node{background:#0D1827;border:1px solid #1D3046;border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;text-align:center;flex:1;min-width:168px;max-width:230px;transition:border-color .12s}.node:hover{border-color:#2E4A66}' +
            '.node .ic{margin-bottom:5px}.node b{font-size:13.5px;font-weight:600}.node span{font-size:12px;color:#53677E;line-height:1.5}' +
            '.hop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;color:#53677E;font-size:11px;letter-spacing:1px}' +
            '.cap{color:#53677E;font-size:12.5px;text-align:center;margin:16px auto 0;max-width:760px;line-height:1.8}' +
            '.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:20px}' +
            '.card{background:#0D1827;border:1px solid #1D3046;border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px;transition:border-color .12s}.card:hover{border-color:#2E4A66}' +
            '.card .ic{width:38px;height:38px}.card h3{font-size:15.5px;font-weight:600}.card h3 span{display:block;font-size:12px;color:#53677E;font-weight:400;margin-top:2px}' +
            '.card p{font-size:13px;color:#8EA3BA;line-height:1.65;flex:1}' +
            '.note{color:#53677E;font-size:12px;margin:14px auto 0;max-width:720px;text-align:center;line-height:1.7}' +
            'footer{margin-top:40px;padding-top:18px;border-top:1px solid #1D3046;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;color:#53677E;font-size:12.5px}' +
            'footer a{color:#8EA3BA;transition:color .12s}footer a:hover{color:#E5EDF7}' +
            '.logo{position:relative;width:60px;height:60px;margin:0 auto 22px}' +
            '.logo i{position:absolute;inset:0;border-radius:12px;border:1.5px solid #2C4661;background:#13233A}' +
            '.logo i:first-child{transform:rotate(-10deg) translate(-6px,2px)}.logo i:nth-child(2){transform:rotate(10deg) translate(6px,2px)}' +
            '.logo i:last-child{background:#F1844F;border-color:#F1844F;display:flex;align-items:center;justify-content:center}' +
            '.logo b{font-size:21px;font-weight:800;color:#1A0D06;letter-spacing:.5px}' +
            '@media(max-width:720px){h1{font-size:30px}.grid{grid-template-columns:1fr 1fr}.cards{grid-template-columns:1fr}' +
            '.flow{flex-direction:column;align-items:stretch}.node{max-width:none;align-items:flex-start;text-align:left}.node .ic{margin-bottom:2px}' +
            '.hop{margin:16px 0}.hop span{display:none}.hop svg{transform:rotate(90deg)}}' +
            '@media(max-width:460px){.grid{grid-template-columns:1fr}.cta .btn{width:100%}}' +
            '@media(min-width:1100px){main{padding:80px 32px 56px}h1{font-size:42px}h2{font-size:24px}' +
            '.tagline{font-size:17px;max-width:720px}.lead{font-size:15px;max-width:720px}.ends{font-size:14px;letter-spacing:3px}' +
            'section{margin-top:32px}.hero{padding-bottom:44px}.grid,.cards{gap:16px}.feat,.card{padding:20px 18px}' +
            '.feat b{font-size:15px}.feat p,.card p{font-size:13.5px}.card h3{font-size:16.5px}.node{max-width:300px;padding:18px 20px}}' +
            '</style></head><body><main>' +
            '<header class="hero">' +
            '<div class="logo" aria-hidden="true"><i></i><i></i><i><b>CC</b></i></div>' +
            '<h1>CC Deck</h1>' +
            '<p class="tagline">把 Claude Code 装进口袋——桌面端能做的，随身都能做：注入指令、权限审批、模型切换、任务跟踪、会话速览，外加主动汇报等随身增强。</p><p class="ends">手机 · 网页 · 桌面 · 手表</p>' +
            '<div class="pills"><span class="pill"><i class="dot"></i>v0.3.32 最新版</span>' +
            '<a class="pill" href="https://github.com/humumu130/cc-deck/blob/main/LICENSE" target="_blank" rel="noopener">MIT License</a>' +
            '<span class="pill">可自建</span></div>' +
            '<div class="cta"><a class="btn pri" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">' +
            '<svg class="st" width="15" height="15" viewBox="0 0 24 24"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>Star on GitHub</a>' +
            '<a class="btn ghost" href="#download"><svg width="15" height="15" viewBox="0 0 24 24"><path d="M12 3v12M6.5 10.5L12 16l5.5-5.5M4 21h16"/></svg>下载客户端</a></div>' +
            '</header>' +
            '<section><p class="kicker">WHY CC DECK</p><h2>把 CLI 会话装进口袋</h2>' +
            '<p class="lead">在 PC 端装一个插件，桌面端的会话就实时同步到随身设备——不止"看"：出门在外也能注入新指令、批准权限、切换模型、调整任务优先级，任务跑完主动来汇报，通知直达手机与手表。适合把 Claude Code 当主力工作流、离开电脑也不想掉线的开发者。</p>' +
            '<div class="grid">' +
            '<div class="feat"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></div><b>随身掌控会话</b><p>多会话实时同步：四态速览、上下文水位、完整转录，断线自动补发不丢帧。</p></div>' +
            '<div class="feat"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg></div><b>注入与审批</b><p>权限审批与提问远程点选；发消息、传图片、远程切模型，随时打断或续聊。</p></div>' +
            '<div class="feat"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></div><b>任务通知随身</b><p>任务完成主动汇报：App 通知 + 手表轻震，点按直达；定时任务随身可查。</p></div>' +
            '<div class="feat"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2l10 5.5L12 13 2 7.5z"/><path d="M2 12.5L12 18l10-5.5"/></svg></div><b>多源多端</b><p>Android / 网页 PWA / Windows / Wear OS 手表四端；多台 PC 聚合同屏，角标区分来源。</p></div>' +
            '<div class="feat"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M12 2.5l7.5 3v5.5c0 4.8-3.1 8.3-7.5 10-4.4-1.7-7.5-5.2-7.5-10V5.5z"/><path d="M9 12l2 2 4-4.5"/></svg></div><b>端到端加密</b><p>密钥不出你的设备：LAN 直连不经第三方，云桥只见密文。</p></div>' +
            '<div class="feat"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><rect x="3" y="3.5" width="18" height="7" rx="1.5"/><rect x="3" y="13.5" width="18" height="7" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg></div><b>可自建</b><p>relay 一行命令起，也提供 Cloudflare Worker 形态；数据只流经你自己的设施。</p></div>' +
            '</div></section>' +
            '<section><p class="kicker">HOW IT WORKS</p><h2>三段链路，端到端加密</h2>' +
            '<div class="flow">' +
            '<div class="node"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></div><b>手机 · 网页 · 桌面 · 手表</b><span>客户端 · 持有密钥</span></div>' +
            '<div class="hop"><span>E2E 加密</span><svg width="46" height="12" viewBox="0 0 46 12"><path d="M1 6h40M36 1.5L41 6l-5 4.5"/></svg></div>' +
            '<div class="node"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a4 4 0 0 0 0-8z"/></svg></div><b>云桥 / LAN</b><span>自建中转 · 只见密文</span></div>' +
            '<div class="hop"><span>密文直达</span><svg width="46" height="12" viewBox="0 0 46 12"><path d="M1 6h40M36 1.5L41 6l-5 4.5"/></svg></div>' +
            '<div class="node"><div class="ic"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg></div><b>你的电脑</b><span>Claude Code CLI · 持有密钥</span></div>' +
            '</div>' +
            '<p class="cap">同一局域网自动直连（LAN）；跨网络经自建云桥中继——密钥只存在于你自己的设备上，中继与公网看到的都只是密文。</p></section>' +
            '<section id="download"><p class="kicker">DOWNLOAD</p><h2>下载客户端</h2>' +
            '<p class="lead">当前版本 v0.3.32 · 四端免费开源，连入同一个 relay 即可互通。</p>' +
            '<div class="cards">' +
            '<div class="card"><div class="ic"><svg width="20" height="20" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></div>' +
            '<h3>手机 App<span>Android APK · Wear OS 手表腕装</span></h3>' +
            '<p>扫码配对即连：会话速览、远程审批、语音发消息；任务完成推送通知，手表抬腕即看。</p>' +
            '<a class="btn pri" href="https://github.com/humumu130/cc-deck/releases/latest" target="_blank" rel="noopener">前往 GitHub Releases</a>' +
            '<a class="btn sec" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">查看源码</a></div>' +
            '<div class="card"><div class="ic"><svg width="20" height="20" viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/></svg></div>' +
            '<h3>桌面端<span>Windows · v0.3.32 · Tauri 约 3.4MB</span></h3>' +
            '<p>轻量原生客户端，托盘常驻、内建更新，与网页端同一套界面。</p>' +
            '<a class="btn pri" href="/dl/cc-deck-desktop-setup.exe">下载桌面安装包（exe）</a>' +
            '<a class="btn sec" href="https://github.com/humumu130/cc-deck/releases" target="_blank" rel="noopener">查看全部历史版本</a></div>' +
            '<div class="card"><div class="ic"><svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14.2 14.2 0 0 1 0 18 14.2 14.2 0 0 1 0-18z"/></svg></div>' +
            '<h3>网页控制台<span>PWA · 免安装 · 全平台</span></h3>' +
            '<p>浏览器打开即用，可添加到主屏幕；跨网时输入 6 位配对码即接入。</p>' +
            '<a class="btn pri" href="/" target="_blank" rel="noopener">打开网页控制台</a>' +
            '<a class="btn sec" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">查看源码 · 自行部署</a></div>' +
            '</div>' +
            '<p class="note">桌面安装包经 Cloudflare KV 边缘分发；APK 超出 KV 单值上限，走 GitHub Releases 或国内镜像。</p></section>' +
            '<footer><span>© 2026 CC Deck · MIT License</span><span>可自建 · 端到端加密中转 · <a href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">GitHub</a></span></footer>' +
            '</main></body></html>',
          { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } },
        );
      }
      if (!/^[\w.-]+$/.test(name) || !env.DL) return new Response("bad name", { status: 400 });
      const obj = await env.DL.get(name, { type: "arrayBuffer" });
      if (!obj) return new Response("not found", { status: 404 });
      // no-store：/dl/<file> 是稳定地址，KV 换新版后二次下载必须拿到新文件，
      // 绝不能让浏览器用缓存的旧安装包（索引页 HTML 才保留 max-age=300）
      return new Response(obj, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name}"`,
          "cache-control": "no-store",
        },
      });
    }
    if (url.pathname !== "/cloud" && url.pathname !== "/cloud-poll" && url.pathname !== "/wan") {
      return new Response("not found", { status: 404 });
    }
    const tok = url.searchParams.get("token") ?? "";
    if (tok !== env.CLOUD_TOKEN && !(env.PUBLIC_TOKEN && tok === env.PUBLIC_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }
    const dev = url.searchParams.get("dev") ?? "";
    if (dev.length < 1 || dev.length > 64) {
      return new Response("bad dev", { status: 400 });
    }
    // 单 DO 实例承载全部连接，路由表才互相可见。
    // 必须转发原始 Request——用 req.url 字符串会丢 Upgrade 头，握手即 500
    const stub = env.ROUTER.get(env.ROUTER.idFromName("main"));
    return stub.fetch(req);
  },
};

export class RouterDO extends DurableObject {
  // 公共桥防滥用限流（家用规模远够不着阈值，只有真滥用才触发）：
  //   总连接（WS+轮询）≤ 600、dev 数 ≤ 400、每 dev 上行帧率 30/s（突发 60）
  private static MAX_CONNS = 600;
  private static MAX_DEVS = 400;
  private static RATE_PER_SEC = 30;
  private static RATE_BURST = 60;
  private buckets = new Map<string, { tokens: number; last: number }>();

  // connId 用随机 id（tag[1]），dev 存 tag[0]：
  // 同 dev 重连时新旧 connId 不同，CloudRouter 的顶替守卫才不会误判
  // HTTP 长轮询会话（connId = "poll:"+sid）没有 WebSocket，下行帧入队等 GET 来取
  private polls = new Map<string, { dev: string; queue: string[]; resolver: (() => void) | null; lastSeen: number; closed: boolean }>();
  private router = new CloudRouter({
    hooks: {
      send: (connId, frame) => {
        if (connId.startsWith("poll:")) {
          const s = this.polls.get(connId.slice(5));
          if (s && !s.closed) {
            if (s.queue.length >= 500) s.queue.shift(); // 丢最旧：旧日志可靠 last_seq 补发，pong/ACK 等新帧不能丢
            s.queue.push(frame);
            s.resolver?.();
            s.resolver = null;
          }
          return;
        }
        for (const ws of this.ctx.getWebSockets(connId)) {
          try {
            // #373 下行解信封：目标为 /wan 手表时 {to,from,data:{t:"wan",frame}} → 明文 frame
            let out = frame;
            try {
              const env = JSON.parse(frame) as { data?: { t?: string; frame?: unknown } };
              if (env?.data?.t === "wan" && typeof env.data.frame === "string") out = env.data.frame;
            } catch { /* 非信封帧原样发 */ }
            ws.send(out);
          } catch (e) {
            // 目标连接濒死时 send 会抛；不兜住会沿 webSocketMessage 冒泡，
            // 把发送方连接一起 1011 踢掉（桥无缓冲，此帧只能丢弃）
            console.log(`[cloud-bridge] send failed conn=${connId}: ${e}`);
          }
        }
      },
      close: (connId, code, reason) => {
        if (connId.startsWith("poll:")) {
          const s = this.polls.get(connId.slice(5));
          if (s) {
            s.closed = true; s.resolver?.(); s.resolver = null;
            this.polls.delete(connId.slice(5));
          }
          return;
        }
        for (const ws of this.ctx.getWebSockets(connId)) {
          try {
            ws.close(code, reason);
          } catch {
            // 已在关闭流程中
          }
        }
      },
    },
    log: (m) => console.log(`[cloud-bridge] ${m}`),
  });

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      this.rehydrate();
      // 只回计数不回 dev 列表：公共桥 /health 无鉴权，dev id 虽是公钥派生非机密，
      // 也没必要向任意访客暴露在线设备元数据
      return Response.json({ ok: true, bridge: "cloudflare", devices: this.router.devs().length });
    }
    if (url.pathname !== "/cloud" && url.pathname !== "/cloud-poll" && url.pathname !== "/wan") return new Response("not found", { status: 404 });
    // #373 /wan 手表明文透传：to=目标 relay dev 必填（该连接的固定投递目标）
    const wanTo = url.pathname === "/wan" ? url.searchParams.get("to") ?? "" : "";
    if (url.pathname === "/wan" && (wanTo.length < 1 || wanTo.length > 64)) return new Response("bad to", { status: 400 });
    const dev = url.searchParams.get("dev") ?? "";
    const rk = url.searchParams.get("rk") ?? ""; // relay 连接上报公钥（发现帧下发；浏览器连接不带）
    if (dev.length < 1 || dev.length > 64) return new Response("bad dev", { status: 400 });
    // 容量门禁：唤醒后按附件/轮询表重建的存活连接计数，超限拒新连（429）。
    // 清扫必须先于门禁：否则 polls 撑爆后所有请求 429、永远到不了 ensurePoll
    // 里的清扫，死 sid 永久占据容量把合法用户全锁死
    this.rehydrate();
    this.sweepPolls();
    const connCount = this.ctx.getWebSockets().length + this.polls.size;
    if (connCount > RouterDO.MAX_CONNS || this.router.devs().length > RouterDO.MAX_DEVS) {
      return new Response("bridge busy", { status: 429 });
    }

    // HTTP 长轮询兜底传输：公司 TLS 解密代理掐 WS 升级（返回 200 非 101）时，
    // 浏览器退化为 POST 上行 + GET 长挂下行，路由/顶替/E2E 协议与 ws 完全一致
    if (url.pathname === "/cloud-poll") {
      const sid = url.searchParams.get("sid") ?? "";
      if (sid.length < 1 || sid.length > 64) return new Response("bad sid", { status: 400 });
      // 限流键用源 IP 而非 URL 里的 dev：poll 路径 dev 是每次请求的参数，
      // 攻击者轮换 dev 即可无限领新令牌桶。GET（建会话长挂）也要耗令牌，
      // 否则占坑洪水完全免费。正常网页 1-2 会话每 20s 一个 GET，30/s/IP 无感
      const ip = req.headers.get("CF-Connecting-IP") ?? dev;
      if (req.method === "POST") {
        // Content-Length 预检 + 限流都先于读 body：超大请求也要耗令牌，
        // 且 8MB body 进内存再 parse/stringify 放大 3 倍，几并发即打爆 DO
        const cl = Number(req.headers.get("content-length") ?? "0");
        if (cl > 8 << 20) return new Response("too large", { status: 413 });
        if (!this.rateOk(ip)) return new Response("rate limited", { status: 429 });
        this.ensurePoll(dev, sid);
        const body = await req.text();
        if (body.length > 8 << 20) return new Response("too large", { status: 413 });
        this.router.handleFrame("poll:" + sid, body);
        return Response.json({ ok: true });
      }
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      // 仅新建会话扣令牌：流式期间浏览器收帧即重 GET（sid 不变）不该被限流，
      // 而占坑攻击必须不断换新 sid——正好逐次扣
      if (!this.polls.has(sid) && !this.rateOk(ip)) return new Response("rate limited", { status: 429 });
      const s = this.ensurePoll(dev, sid);
      const waitMs = Math.min(Number(url.searchParams.get("wait") ?? "20") || 20, 25) * 1000;
      if (s.queue.length === 0 && !s.closed) {
        await new Promise<void>((r) => {
          s.resolver = r;
          setTimeout(r, waitMs);
        });
        s.resolver = null;
      }
      const frames = s.queue.splice(0, s.queue.length);
      return Response.json({ frames, closed: s.closed });
    }

    // 唤醒可能由新连接触发：先按附件重建路由表，同 dev 顶替才能正确踢旧连接
    this.rehydrate();

    // 顶替：踢掉同 dev 的旧连接（休眠唤醒后 getWebSockets 只返回存活的）
    for (const old of this.ctx.getWebSockets(dev)) {
      try {
        old.close(4000, "replaced");
      } catch {
        // ignore
      }
    }

    const connId = crypto.randomUUID();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [dev, connId]);
    // rk 进 attachment：DO 休眠唤醒 rehydrate 重建路由表时带回，发现帧不因唤醒丢公钥
    pair[1].serializeAttachment(JSON.stringify({ dev, connId, rk, wanTo: wanTo || undefined, ip: req.headers.get("CF-Connecting-IP") }));
    this.router.register(connId, dev, rk || undefined);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // 每 source（源 IP，本地 dev 兜底）令牌桶帧率限流（上行帧/轮询请求）；
  // 超限返回 false，调用方踢连接/拒请求
  private rateOk(source: string): boolean {
    const now = Date.now();
    if (this.buckets.size > 2000) {
      for (const [k, b] of this.buckets) {
        if (now - b.last > 600_000) this.buckets.delete(k);
      }
    }
    let b = this.buckets.get(source);
    if (!b) {
      b = { tokens: RouterDO.RATE_BURST, last: now };
      this.buckets.set(source, b);
    }
    // Math.max 防 CF 边缘时钟回拨把 elapsed 算成负、桶被扣穿
    const elapsed = Math.max(0, now - b.last);
    b.tokens = Math.min(RouterDO.RATE_BURST, b.tokens + (elapsed / 1000) * RouterDO.RATE_PER_SEC);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  // 轮询会话按 sid 记账：每次请求 touch，>120s 没来即过期（sweepPolls 清扫）。
  // 每次请求都 register（同 connId 幂等不顶替自己）——DO 被逐出后路由表丢失，
  // 下一个 POST/GET 即重挂，relay→浏览器方向的帧不再 ROUTE_MISS。
  // register 用会话既有的 p.dev：他人 POST 猜中 sid 时不能把会话改道到自己名下。
  // 同 dev 轮换 sid 占坑由 router 的顶替语义天然化解：新 sid register 踢掉旧
  // poll 会话（close hook 移出 polls），同 dev 在线 poll 会话恒 ≤ 1
  private ensurePoll(dev: string, sid: string) {
    let p = this.polls.get(sid);
    if (!p) {
      p = { dev, queue: [], resolver: null, lastSeen: Date.now(), closed: false };
      this.polls.set(sid, p);
    }
    p.lastSeen = Date.now();
    this.router.register("poll:" + sid, p.dev);
    return p;
  }

  // 死会话清扫。必须在容量门禁之前调用（见 fetch 内注释）
  private sweepPolls(): void {
    const now = Date.now();
    for (const [s, p] of this.polls) {
      if (now - p.lastSeen > 120_000) {
        p.closed = true; p.resolver?.(); p.resolver = null;
        this.polls.delete(s);
        this.router.unregister("poll:" + s);
      }
    }
  }

  // 本地 workerd 的 webSocketMessage 里 ws.tags 未暴露（undefined），
  // 但 serializeAttachment/deserializeAttachment 可用——connId 存附件；
  // getWebSockets(tag) 的 tag 过滤仍然有效（顶替/定向发送用它）
  private attachOf(ws: WebSocket): { dev?: string; connId?: string; rk?: string; ip?: string; wanTo?: string } | undefined {
    const raw = (ws as { deserializeAttachment?: () => unknown }).deserializeAttachment?.();
    if (typeof raw !== "string") return undefined;
    try {
      return JSON.parse(raw) as { dev?: string; connId?: string; rk?: string; ip?: string; wanTo?: string };
    } catch {
      return undefined;
    }
  }

  // 休眠唤醒后 CloudRouter 内存表已丢，但 WebSocket 与附件还在运行时：
  // 首个事件到达时按附件重建路由表，否则 handleFrame 全部静默丢弃、对端 ROUTE_MISS
  private rehydrated = false;
  private rehydrate(): void {
    if (this.rehydrated) return;
    this.rehydrated = true;
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.attachOf(ws);
      if (a?.dev && a.connId) this.router.register(a.connId, a.dev, a.rk || undefined);
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    this.rehydrate();
    const a = this.attachOf(ws);
    if (!a?.connId) return;
    if (!this.rateOk(a.ip ?? a.dev ?? "?")) {
      try { ws.close(4291, "rate limited"); } catch { /* 已在关闭流程 */ }
      this.router.unregister(a.connId);
      return;
    }
    // #373 /wan 上行包信封：手表明文帧 → {to:wanTo, data:{t:"wan",from,frame}}
    if (a.wanTo) {
      this.router.handleFrame(
        a.connId,
        JSON.stringify({ to: a.wanTo, data: { t: "wan", from: a.dev, frame: message } }),
      );
      return;
    }
    this.router.handleFrame(a.connId, message);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.rehydrate();
    const connId = this.attachOf(ws)?.connId;
    if (connId) this.router.unregister(connId);
  }
}
