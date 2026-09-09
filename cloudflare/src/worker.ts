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
  ASSETS?: Fetcher; // [assets] 静态托管绑定：/app 路径映射网页控制台
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // #24 域名分层：cc-deck.humumu.online = 新主域（/=项目主页、/app=网页控制台、/dl=下载）；
    // cc.humumu.online = 旧域（文档路径 301 平移；/cloud /cloud-poll /wan /health 的 ws/API 通道双域常驻，
    // ws upgrade 不跟随 301——relay 与手机正在用的桥连接绝不能断，烘焙地址收口留给后续版本）
    const NEW_HOST = "cc-deck.humumu.online";
    const host = url.hostname;
    if (host === NEW_HOST) {
      // 新域根路径 = 项目主页：内部重写到 /dl/ 复用落地页逻辑（零搬运大段字符串）
      if (url.pathname === "/" || url.pathname === "/index.html") url.pathname = "/dl/";
      // 新域 /app(|/app/*) = 网页控制台：剥掉 /app 前缀交 ASSETS 静态托管（/app → /，/app/nacl.js → /nacl.js）
      else if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
        if (!env.ASSETS) return new Response("assets unavailable", { status: 503 });
        const inner = url.pathname.slice(4) || "/";
        return env.ASSETS.fetch(new Request("https://assets.local" + inner + url.search, req));
      }
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      // 旧域文档根：301 到新域 /app（旧 tab 内部资源仍直出不断链）
      return Response.redirect("https://" + NEW_HOST + "/app", 301);
    }
    if (url.pathname === "/health") {
      // 转发进 DO 拿设备列表（与 Node 形态 /health 对齐；会唤醒 DO，无连接时即刻再休眠）
      const stub = env.ROUTER.get(env.ROUTER.idFromName("main"));
      return stub.fetch(new Request("https://router/health"));
    }
    // 安装包分发（/dl/<file>）：文件放 KV（ECS 镜像对 CF 境外出口 403），
    // 全程不出 Cloudflare——公司只需能开本域即可下载。文件名白名单防滥用
    if (url.pathname.startsWith("/dl/")) {
      const name = url.pathname.slice(4);
      // /dl/ 无文件名：开源项目落地页（设计稿全量内联移植：hero / 特性 / 原理 / 下载 / CTA / 页脚）。
      // CSS/JS/favicon 全内联零外部请求；桌面端走 KV，APK 超 KV 单值上限只指 GitHub Releases
      if (name === "") {
        return new Response(
          '<!DOCTYPE html><html lang="zh-CN"><head>' +
          '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<meta name="color-scheme" content="dark"><meta name="theme-color" content="#05080F">' +
          '<meta name="description" content="CC Deck——Claude Code 的随身控制台：在手机、网页、桌面远程完成桌面端的几乎一切——注入指令、批准权限、切换模型、任务跟踪、会话速览，并有主动通知等随身增强，手表亦可。可自建 relay，端到端加密。">' +
          '<meta property="og:title" content="CC Deck — Claude Code 的随身控制台">' +
          '<meta property="og:description" content="不止远程查看：在手机、网页、桌面注入指令、批准权限、切换模型、跟踪任务、接收汇报——桌面端的几乎一切随身可用，手表亦可。可自建、端到端加密。">' +
          '<meta property="og:type" content="website">' +
          '<meta property="og:url" content="https://cc.humumu.online/dl/">' +
          '<title>CC Deck — Claude Code 的随身控制台</title>' +
          '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2064%2064%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%23F6976C%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%23F1844F%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%2264%22%20height%3D%2264%22%20rx%3D%2214%22%20fill%3D%22url(%23g)%22%2F%3E%3Ctext%20x%3D%2232%22%20y%3D%2244%22%20font-size%3D%2230%22%20font-weight%3D%22700%22%20text-anchor%3D%22middle%22%20fill%3D%22%231A0D06%22%20font-family%3D%22system-ui%2C-apple-system%2C%27Segoe%20UI%27%2Csans-serif%22%3ECC%3C%2Ftext%3E%3C%2Fsvg%3E">' +
          '<style>' +
          ':root{--bg:#05080F;--panel:rgba(13,24,39,.55);--panel-solid:#0C1624;--line:rgba(148,183,255,.13);--line-strong:rgba(148,183,255,.24);--text:#E8EFF9;--muted:#8EA3BA;--faint:#53677E;--brand:#F1844F;--brand-2:#F6A96C;--brand-ink:#1A0D06;--green:#55D98A;--blue:#6AA6FF;--violet:#A78BFA;--radius:14px;--font:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,"Cascadia Code",Consolas,"JetBrains Mono",monospace}' +
          '*{box-sizing:border-box;margin:0;padding:0}html{scroll-behavior:smooth}' +
          'body{background:var(--bg);color:var(--text);font:15px/1.75 var(--font);min-height:100vh;overflow-x:hidden;-webkit-font-smoothing:antialiased}' +
          'a{color:inherit;text-decoration:none}' +
          'svg{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}svg.st{fill:currentColor;stroke:none}' +
          '::selection{background:rgba(241,132,79,.32)}' +
          '.wrap{max-width:1120px;margin:0 auto;padding:0 28px}' +
          /* ---------- background layers ---------- */
          '.bg{position:fixed;inset:0;z-index:-2;overflow:hidden}' +
          '.glow{position:absolute;border-radius:50%;filter:blur(110px)}' +
          '.glow-a{width:900px;height:620px;left:50%;top:-320px;transform:translateX(-62%);background:radial-gradient(closest-side,rgba(241,132,79,.17),transparent 72%)}' +
          '.glow-b{width:760px;height:560px;right:-280px;top:140px;background:radial-gradient(closest-side,rgba(106,166,255,.09),transparent 72%)}' +
          '.grid-overlay{position:absolute;inset:0;background-image:radial-gradient(rgba(148,183,255,.11) 1px,transparent 1px);background-size:34px 34px;mask-image:radial-gradient(ellipse 78% 46% at 50% 0%,#000 32%,transparent 78%);-webkit-mask-image:radial-gradient(ellipse 78% 46% at 50% 0%,#000 32%,transparent 78%)}' +
          /* ---------- nav ---------- */
          '.nav{position:fixed;top:0;left:0;right:0;z-index:50;border-bottom:1px solid transparent;transition:background .3s,border-color .3s,backdrop-filter .3s}' +
          '.nav.scrolled{background:rgba(5,8,15,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-color:var(--line)}' +
          '.nav-inner{display:flex;align-items:center;gap:28px;height:62px}' +
          '.brand{display:flex;align-items:center;gap:10px;font-weight:700}' +
          '.brand-name{font-size:15.5px;letter-spacing:.2px}' +
          '.brand-mark{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--brand-2),var(--brand));color:var(--brand-ink);font-size:12.5px;font-weight:800;letter-spacing:.3px;box-shadow:0 2px 14px rgba(241,132,79,.35)}' +
          '.brand-mark-sm{width:26px;height:26px;font-size:11px;border-radius:7px;box-shadow:none}' +
          '.nav-links{display:flex;gap:26px;margin:0 auto}' +
          '.nav-links a{font-size:13.5px;color:var(--muted);transition:color .15s}.nav-links a:hover{color:var(--text)}' +
          '.nav-actions{display:flex;align-items:center;gap:12px}' +
          '.nav-gh{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border:1px solid var(--line);border-radius:9px;font-size:13px;color:var(--muted);background:rgba(13,24,39,.4);transition:color .15s,border-color .15s}' +
          '.nav-gh:hover{color:var(--text);border-color:var(--line-strong)}' +
          /* ---------- buttons ---------- */
          '.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:10px;font-weight:600;font-size:14px;line-height:1;border:1px solid transparent;cursor:pointer;white-space:nowrap;transition:transform .15s,box-shadow .2s,background .15s,border-color .15s,color .15s}' +
          '.btn-pri{background:linear-gradient(180deg,var(--brand-2),var(--brand));color:var(--brand-ink);height:44px;padding:0 22px;box-shadow:0 6px 22px rgba(241,132,79,.26),inset 0 1px 0 rgba(255,255,255,.28)}' +
          '.btn-pri:hover{transform:translateY(-1px);box-shadow:0 10px 30px rgba(241,132,79,.38),inset 0 1px 0 rgba(255,255,255,.28)}' +
          '.btn-ghost{background:rgba(13,24,39,.5);border-color:var(--line-strong);color:var(--text);height:44px;padding:0 22px}' +
          '.btn-ghost:hover{border-color:rgba(148,183,255,.4);background:rgba(18,32,47,.7);transform:translateY(-1px)}' +
          '.btn-lg{height:50px;padding:0 26px;font-size:15px;border-radius:12px}' +
          '.btn-sm{height:36px;padding:0 16px;font-size:13px}' +
          '.btn-sm-block{height:38px;font-size:12.5px;background:transparent;border-color:var(--line);color:var(--muted)}' +
          '.btn-sm-block:hover{color:var(--text);border-color:var(--line-strong)}' +
          /* ---------- shared section chrome ---------- */
          '.section{margin-top:130px;scroll-margin-top:80px}' +
          '.kicker{font-size:11.5px;font-weight:700;letter-spacing:3px;color:var(--brand);display:flex;align-items:center;gap:10px}' +
          '.kicker::before{content:"";width:22px;height:1px;background:var(--brand);opacity:.6}' +
          'h2{font-size:clamp(26px,3.4vw,36px);font-weight:750;letter-spacing:-.4px;margin:12px 0 10px}' +
          '.lead{color:var(--muted);font-size:15px;max-width:640px}' +
          /* ---------- hero ---------- */
          '.hero{padding-top:150px;text-align:center}' +
          '.hero-badge{display:inline-flex;align-items:center;gap:9px;height:32px;padding:0 14px 0 12px;border-radius:999px;border:1px solid var(--line-strong);background:rgba(13,24,39,.55);font-size:12.5px;color:var(--muted);transition:border-color .15s,color .15s}' +
          '.hero-badge:hover{border-color:rgba(241,132,79,.55);color:var(--text)}' +
          '.hero-badge svg{color:var(--faint)}' +
          '.hero-badge-sep{color:var(--faint)}' +
          '.pulse{width:7px;height:7px;border-radius:50%;background:var(--green);flex:none;animation:pulse 2.2s ease-out infinite}' +
          '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(85,217,138,.5)}70%{box-shadow:0 0 0 8px rgba(85,217,138,0)}100%{box-shadow:0 0 0 0 rgba(85,217,138,0)}}' +
          'h1{margin:26px auto 0;max-width:820px;font-size:clamp(40px,7vw,76px);font-weight:800;line-height:1.14;letter-spacing:-1px}' +
          'h1 em{font-style:normal;background:linear-gradient(92deg,var(--brand-2) 10%,var(--brand) 55%,#F1734F 90%);-webkit-background-clip:text;background-clip:text;color:transparent}' +
          '.hero-tagline{max-width:620px;margin:22px auto 0;color:var(--muted);font-size:16.5px}' +
          '.hero-cta{display:flex;gap:14px;justify-content:center;margin-top:34px;flex-wrap:wrap}' +
          '.hero-chips{display:flex;gap:9px;justify-content:center;margin-top:26px;flex-wrap:wrap}' +
          '.chip{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 13px;border-radius:999px;border:1px solid var(--line);background:rgba(13,24,39,.45);font-size:12.5px;color:var(--muted)}' +
          '.chip-soft{border-style:dashed;color:var(--faint)}' +
          '.dot{width:6px;height:6px;border-radius:50%;flex:none}' +
          '.dot-green{background:var(--green)}.dot-orange{background:var(--brand)}.dot-blue{background:var(--blue)}.dot-violet{background:var(--violet)}' +
          /* ---------- stage: terminal × phone ---------- */
          '.stage{position:relative;margin:74px auto 0;max-width:980px;text-align:left}' +
          '.terminal{width:min(620px,100%);border-radius:var(--radius);background:rgba(8,14,24,.82);border:1px solid var(--line-strong);box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.2),0 -20px 80px rgba(241,132,79,.06) inset;overflow:hidden}' +
          '.term-bar{display:flex;align-items:center;gap:7px;height:40px;padding:0 14px;border-bottom:1px solid var(--line);background:rgba(13,24,39,.5)}' +
          '.term-bar i{width:10px;height:10px;border-radius:50%;background:#2A3B52}' +
          '.term-bar i:first-child{background:#FF5F57}.term-bar i:nth-child(2){background:#FEBC2E}.term-bar i:nth-child(3){background:#28C840}' +
          '.term-title{font:12px var(--mono);color:var(--faint);margin-left:8px}' +
          '.term-live{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--green)}' +
          '.term-body{padding:16px 18px 18px;font:12.5px/2 var(--mono)}' +
          '.t-user{color:var(--text)}' +
          '.t-prompt{color:var(--brand);margin-right:8px}' +
          '.t-ai{color:var(--muted)}' +
          '.t-caret{color:var(--brand);margin-right:8px}' +
          '.t-tool{color:var(--faint)}.t-tool span{color:var(--blue)}.t-tool em{font-style:normal;color:var(--faint);margin-left:10px}' +
          '.t-dim{color:var(--faint)}' +
          '.t-perm{margin:8px 0;padding:10px 12px;border-radius:9px;border:1px solid rgba(241,132,79,.4);background:rgba(241,132,79,.07)}' +
          '.t-perm-q{color:var(--brand-2);font-weight:600}' +
          '.t-perm-btns{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}' +
          '.t-btn{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 11px;border-radius:6px;font-size:11px;font-weight:600;border:1px solid var(--line-strong);color:var(--muted);background:rgba(13,24,39,.6)}' +
          '.t-btn-yes{background:linear-gradient(180deg,var(--brand-2),var(--brand));border-color:transparent;color:var(--brand-ink);animation:glow 2.6s ease-in-out infinite}' +
          '.t-btn-soft{border-style:dashed}' +
          '@keyframes glow{0%,100%{box-shadow:0 0 0 0 rgba(241,132,79,.0)}50%{box-shadow:0 0 14px 1px rgba(241,132,79,.45)}}' +
          '.t-remote{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--brand);font-family:var(--font)}' +
          /* phone */
          '.phone{position:absolute;right:2%;top:-34px;z-index:3;width:248px;border-radius:34px;padding:9px;background:linear-gradient(180deg,#1B2739,#0C1420);border:1px solid rgba(148,183,255,.22);box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 60px rgba(241,132,79,.1)}' +
          '.phone-notch{width:74px;height:5px;border-radius:999px;margin:2px auto 8px;background:rgba(148,183,255,.18)}' +
          '.phone-screen{border-radius:26px;overflow:hidden;background:#070D17;border:1px solid rgba(148,183,255,.1);padding:13px 12px 12px;font-family:var(--font)}' +
          '.app-head{display:flex;align-items:flex-start;justify-content:space-between;padding:2px 2px 10px}' +
          '.app-head b{font-size:13px;letter-spacing:.2px}' +
          '.app-pc{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--green);margin-top:2px}' +
          '.app-count{font-size:10px;color:var(--faint);border:1px solid var(--line);border-radius:999px;padding:2px 8px}' +
          '.app-list{display:flex;flex-direction:column;gap:6px}' +
          '.app-row{display:flex;align-items:center;gap:8px;padding:8px 9px;border-radius:9px;border:1px solid var(--line);background:rgba(13,24,39,.45)}' +
          '.app-row-pending{border-color:rgba(241,132,79,.45);background:rgba(241,132,79,.06)}' +
          '.app-row-main{flex:1;min-width:0}' +
          '.app-row-main b{display:block;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
          '.app-row-main span{font-size:9.5px;color:var(--faint)}' +
          '.app-ctx{font:9.5px var(--mono);color:var(--muted)}' +
          '.app-badge{font-size:9px;font-weight:700;color:var(--brand-ink);background:var(--brand);border-radius:999px;padding:1px 7px}' +
          '.app-approve{margin-top:8px;padding:9px 10px;border-radius:10px;border:1px solid rgba(241,132,79,.4);background:rgba(241,132,79,.07)}' +
          '.app-approve p{font:11px var(--mono);color:var(--brand-2)}.app-approve p span{color:var(--muted)}' +
          '.app-approve-btns{display:flex;gap:7px;margin-top:7px}' +
          '.app-input{margin-top:9px;display:flex;align-items:center;justify-content:space-between;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--line);background:rgba(13,24,39,.4);font-size:10.5px;color:var(--faint)}' +
          '.app-input i{width:22px;height:22px;border-radius:7px;background:var(--brand);position:relative}' +
          '.app-input i::after{content:"";position:absolute;inset:0;margin:auto;width:8px;height:8px;border:1.6px solid var(--brand-ink);border-top:0;border-left:0;transform:rotate(-45deg) translate(-1px,-2px)}' +
          /* e2e link between terminal & phone */
          '.e2e-link{position:absolute;z-index:2;left:calc(min(620px,100%) - 60px);top:210px;width:220px;display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--faint)}' +
          '.e2e-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 11px;border-radius:999px;border:1px solid var(--line-strong);background:rgba(7,13,23,.9);font-size:11px;color:var(--muted);z-index:2}' +
          '.e2e-chip svg{color:var(--green)}' +
          '.e2e-dash{width:100%;height:8px;stroke:rgba(85,217,138,.55);stroke-width:1.6;fill:none}' +
          '.e2e-dash path{animation:dash 1.6s linear infinite}' +
          '@keyframes dash{to{stroke-dashoffset:-24}}' +
          /* floating chips */
          '.float-chip{position:absolute;z-index:4;display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px;border-radius:999px;font-size:12px;color:var(--text);background:rgba(10,18,30,.85);border:1px solid var(--line-strong);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:0 14px 34px rgba(0,0,0,.45);animation:floaty 5s ease-in-out infinite}' +
          '.float-chip svg{color:var(--green)}' +
          '.fc-a{right:0;top:246px}' +
          '.fc-b{left:34px;bottom:-16px;animation-delay:1.4s}.fc-b svg{color:var(--brand-2)}' +
          '@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}' +
          /* ---------- bento features ---------- */
          '.bento{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:44px}' +
          '.cell{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:22px;display:flex;flex-direction:column;gap:16px;transition:transform .25s,border-color .25s,background .25s}' +
          '.cell:hover{transform:translateY(-3px);border-color:var(--line-strong);background:rgba(16,29,45,.65)}' +
          '.cell-wide{grid-column:span 2;flex-direction:row;align-items:stretch;gap:26px}.cell-wide .cell-text{flex:1}' +
          '.cell-full{grid-column:span 3;flex-direction:row;align-items:center;gap:26px}.cell-full .cell-text{flex:1}' +
          '.cell-text{display:flex;flex-direction:column;gap:9px}' +
          '.cell-text h3{font-size:16.5px;font-weight:650;letter-spacing:.1px}' +
          '.cell-text p{font-size:13.5px;color:var(--muted)}' +
          '.ic{width:38px;height:38px;border-radius:10px;flex:none;display:flex;align-items:center;justify-content:center;background:rgba(241,132,79,.1);border:1px solid rgba(241,132,79,.26);color:var(--brand-2)}' +
          '.cell-art{display:flex;flex-direction:column;justify-content:center;gap:7px;min-width:0;font-size:12px}' +
          '.sessions{flex:1;max-width:320px}' +
          '.s-row{display:flex;align-items:center;gap:9px;padding:8px 11px;border-radius:9px;border:1px solid var(--line);background:rgba(7,13,23,.5);font-size:12px;color:var(--muted)}' +
          '.s-row span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
          '.s-row em{font-style:normal;font-size:10.5px;color:var(--faint)}' +
          '.s-hot{border-color:rgba(241,132,79,.45);color:var(--text)}.s-hot em{color:var(--brand-2)}' +
          '.s-meter{height:6px;border-radius:999px;background:rgba(148,183,255,.1);overflow:hidden;margin-top:6px}' +
          '.s-meter span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand-2),var(--brand))}' +
          '.s-cap{font-size:10.5px;color:var(--faint)}' +
          '.approve-art{gap:9px;align-items:stretch}.approve-art .t-btn{height:30px;font-size:12px}' +
          '.key-art{flex-direction:row;align-items:center;gap:10px}' +
          '.kbd{font:11.5px var(--mono);padding:5px 10px;border-radius:7px;border:1px solid rgba(85,217,138,.4);color:var(--green);background:rgba(85,217,138,.07)}' +
          '.kbd-dim{border-color:var(--line-strong);color:var(--faint);background:rgba(13,24,39,.5)}' +
          '.key-art svg{color:var(--faint)}' +
          '.cmd-art{flex-direction:row;align-items:center;gap:8px;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:rgba(7,13,23,.6)}' +
          '.cmd-art code{font:12.5px var(--mono);color:var(--green)}' +
          '.cmd-art code::before{content:"$ ";color:var(--faint)}' +
          '.copy-btn{margin-left:auto;width:26px;height:26px;border-radius:7px;display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid var(--line);color:var(--muted);cursor:pointer;transition:color .15s,border-color .15s}' +
          '.copy-btn:hover{color:var(--text);border-color:var(--line-strong)}' +
          '.copy-btn.done{color:var(--green);border-color:rgba(85,217,138,.5)}' +
          '.platforms{flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap}' +
          '.plat{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 15px;border-radius:999px;border:1px solid var(--line);background:rgba(7,13,23,.5);font-size:12.5px;color:var(--muted)}' +
          '.toast{display:inline-flex;align-items:center;gap:9px;padding:9px 13px;border-radius:10px;border:1px solid var(--line-strong);background:rgba(7,13,23,.7);font-size:12px;color:var(--text);box-shadow:0 12px 30px rgba(0,0,0,.35);animation:floaty 5s ease-in-out infinite}' +
          /* ---------- steps ---------- */
          '.steps{display:flex;align-items:flex-start;gap:18px;margin-top:48px}' +
          '.step{flex:1;min-width:0;position:relative;padding:22px 22px 20px;border-radius:var(--radius);background:var(--panel);border:1px solid var(--line);transition:transform .25s,border-color .25s}' +
          '.step:hover{transform:translateY(-3px);border-color:var(--line-strong)}' +
          '.step-no{font:800 13px var(--mono);color:var(--brand);display:inline-flex;width:40px;height:40px;border-radius:11px;align-items:center;justify-content:center;background:rgba(241,132,79,.1);border:1px solid rgba(241,132,79,.3);margin-bottom:14px}' +
          '.step h3{font-size:16px;font-weight:650;margin-bottom:6px}' +
          '.step p{font-size:13px;color:var(--muted)}' +
          '.step-line{flex:0 0 44px;height:1px;margin-top:42px;align-self:flex-start;background-image:linear-gradient(90deg,var(--line-strong) 55%,transparent 45%);background-size:10px 1px}' +
          /* ---------- e2e flow ---------- */
          '.flow{display:flex;align-items:stretch;justify-content:center;gap:12px;margin-top:48px;flex-wrap:wrap}' +
          '.fnode{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px 18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;text-align:center;flex:1;min-width:180px;max-width:250px;transition:border-color .2s,transform .2s}' +
          '.fnode:hover{border-color:var(--line-strong);transform:translateY(-2px)}' +
          '.fnode .ic{margin-bottom:6px}' +
          '.fnode b{font-size:13.5px;font-weight:600}' +
          '.fnode span{font-size:11.5px;color:var(--faint)}' +
          '.fnode-mid{border-color:rgba(85,217,138,.3)}' +
          '.fnode-mid .ic{background:rgba(85,217,138,.08);border-color:rgba(85,217,138,.3);color:var(--green)}' +
          '.fhop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--faint);font-size:10.5px;letter-spacing:1px}' +
          '.fhop svg{stroke:var(--faint)}' +
          '.cap{color:var(--faint);font-size:12.5px;text-align:center;margin-top:22px}' +
          /* ---------- download ---------- */
          '.dl-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:44px}' +
          '.dl-card{position:relative;display:flex;flex-direction:column;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:24px 22px 22px;transition:transform .25s,border-color .25s}' +
          '.dl-card:hover{transform:translateY(-4px);border-color:var(--line-strong)}' +
          '.dl-card p{font-size:13px;color:var(--muted);flex:1}' +
          '.dl-card-hot{border-color:rgba(241,132,79,.45);background:rgba(241,132,79,.045)}' +
          '.dl-card-hot:hover{border-color:rgba(241,132,79,.7)}' +
          '.dl-flag{position:absolute;top:-11px;right:18px;height:22px;padding:0 11px;display:inline-flex;align-items:center;border-radius:999px;background:linear-gradient(180deg,var(--brand-2),var(--brand));color:var(--brand-ink);font-size:11px;font-weight:700;letter-spacing:1px;box-shadow:0 4px 14px rgba(241,132,79,.4)}' +
          '.dl-head{display:flex;gap:13px;align-items:center}' +
          '.dl-head h3{font-size:16px;font-weight:650}' +
          '.dl-head h3 span{display:block;font-size:11.5px;color:var(--faint);font-weight:400;margin-top:3px}' +
          '.dl-btns{display:flex;flex-direction:column;gap:8px}' +
          '.dl-btns .btn{width:100%;height:40px;font-size:13px}' +
          '.note{color:var(--faint);font-size:12px;margin-top:18px;text-align:center}' +
          /* ---------- final cta ---------- */
          '.cta-band{position:relative;overflow:hidden;text-align:center;border-radius:22px;padding:72px 32px;background:linear-gradient(180deg,rgba(16,29,45,.7),rgba(10,17,28,.7));border:1px solid var(--line-strong)}' +
          '.cta-glow{position:absolute;left:50%;top:-160px;transform:translateX(-50%);width:640px;height:320px;border-radius:50%;background:radial-gradient(closest-side,rgba(241,132,79,.22),transparent 70%);filter:blur(50px);pointer-events:none}' +
          '.cta-band h2{margin:0}' +
          '.cta-band p{color:var(--muted);margin-top:10px;font-size:15px}' +
          '.cta-band .hero-cta{margin-top:30px}' +
          /* ---------- footer ---------- */
          'footer{margin-top:110px;padding:26px 0 40px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;color:var(--faint);font-size:12.5px}' +
          '.foot-brand{display:flex;align-items:center;gap:10px}' +
          '.foot-links{display:flex;gap:20px}' +
          '.foot-links a{color:var(--muted);transition:color .15s}.foot-links a:hover{color:var(--text)}' +
          /* ---------- reveal on scroll ---------- */
          '.reveal{opacity:0;transform:translateY(26px);transition:opacity .8s cubic-bezier(.2,.6,.2,1) var(--d,0s),transform .8s cubic-bezier(.2,.6,.2,1) var(--d,0s)}' +
          '.reveal.in{opacity:1;transform:none}' +
          '.no-observer .reveal{opacity:1;transform:none}' +
          '@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}.reveal{opacity:1;transform:none;transition:none}.pulse,.float-chip,.toast,.t-btn-yes,.e2e-dash path{animation:none}}' +
          /* ---------- responsive ---------- */
          '@media (max-width:1020px){.fc-a{right:4px}.e2e-link{left:calc(min(620px,100%) - 130px);width:170px}}' +
          '@media (max-width:900px){.stage{display:flex;flex-direction:column;align-items:center;gap:26px}.terminal{width:100%}.phone{position:static}.e2e-link{position:static;width:min(420px,90%)}.e2e-dash path{animation:none}.float-chip{display:none}.bento{grid-template-columns:1fr 1fr}.cell-wide,.cell-full{grid-column:span 2;flex-direction:column;gap:16px}.dl-grid{grid-template-columns:1fr}.steps{flex-direction:column}.step-line{display:none}.nav-links{display:none}}' +
          '@media (max-width:620px){.wrap{padding:0 18px}.hero{padding-top:118px}.section{margin-top:90px}.bento{grid-template-columns:1fr}.cell-wide,.cell-full{grid-column:span 1}.hero-cta .btn{width:100%}.nav-gh span{display:none}.nav-gh{padding:0 10px}.term-body{font-size:11px}.t-remote{display:none}footer{justify-content:center;text-align:center}}' +
          '</style></head><body>' +
          '<div class="bg" aria-hidden="true"><div class="glow glow-a"></div><div class="glow glow-b"></div><div class="grid-overlay"></div></div>' +
          '<nav class="nav" id="nav"><div class="wrap nav-inner">' +
          '<a class="brand" href="#top"><span class="brand-mark">CC</span><span class="brand-name">CC Deck</span></a>' +
          '<div class="nav-links"><a href="#features">特性</a><a href="#how">工作原理</a><a href="#download">下载</a></div>' +
          '<div class="nav-actions"><a class="nav-gh" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">' +
          '<svg class="st" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.24 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.14c0 .3.21.67.8.55A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>' +
          '<span>GitHub</span></a>' +
          '<a class="btn btn-sm btn-pri" href="#download">下载客户端</a></div></div></nav>' +
          '<main id="top">' +
          '<header class="hero wrap">' +
          '<a class="hero-badge reveal" href="https://github.com/humumu130/cc-deck/releases" target="_blank" rel="noopener"><i class="pulse"></i>v0.3.33<span class="hero-badge-sep">·</span>支持 Wear OS 手表<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></a>' +
          '<h1 class="reveal" style="--d:.06s">把 Claude Code 会话<br><em>装进口袋</em></h1>' +
          '<p class="hero-tagline reveal" style="--d:.12s">手机、网页、桌面与手表实时同步 PC 端会话——出门在外也能看到它卡在哪一步审批，顺手点 Allow、把新想法塞进队列，任务跑完主动来汇报。</p>' +
          '<div class="hero-cta reveal" style="--d:.18s">' +
          '<a class="btn btn-pri btn-lg" href="#download"><svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 3v12M6.5 10.5L12 16l5.5-5.5M4 21h16"/></svg>下载客户端</a>' +
          '<a class="btn btn-ghost btn-lg" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener"><svg class="st" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>Star on GitHub</a>' +
          '</div>' +
          '<div class="hero-chips reveal" style="--d:.24s">' +
          '<span class="chip"><i class="dot dot-green"></i>Android</span>' +
          '<span class="chip"><i class="dot dot-blue"></i>网页 PWA</span>' +
          '<span class="chip"><i class="dot dot-violet"></i>Windows</span>' +
          '<span class="chip"><i class="dot dot-orange"></i>Wear OS</span>' +
          '<span class="chip chip-soft">四端免费开源 · MIT</span>' +
          '</div>' +
          '<div class="stage reveal" style="--d:.3s" aria-hidden="true">' +
          '<div class="terminal">' +
          '<div class="term-bar"><i></i><i></i><i></i><span class="term-title">你的电脑 · Claude Code CLI</span><span class="term-live"><i class="dot dot-green"></i>运行中</span></div>' +
          '<div class="term-body">' +
          '<p class="t-user"><span class="t-prompt">❯</span>把登录改成 OAuth，写好测试</p>' +
          '<p class="t-ai"><span class="t-caret">⏺</span>先看一下现有的认证实现…</p>' +
          '<p class="t-tool">Read <span>src/auth/session.ts</span><em>128 行</em></p>' +
          '<p class="t-tool">Write <span>src/auth/oauth.ts</span><em>+96 行</em></p>' +
          '<div class="t-perm">' +
          '<p class="t-perm-q">⚠ 允许写入 src/auth/oauth.ts？</p>' +
          '<div class="t-perm-btns">' +
          '<span class="t-btn t-btn-yes">允许</span>' +
          '<span class="t-btn">拒绝</span>' +
          '<span class="t-remote"><svg viewBox="0 0 24 24" width="12" height="12"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>正在等你从手机确认…</span>' +
          '</div></div>' +
          '<p class="t-dim">⏺ 等待权限确认中（CC Deck 已同步）</p>' +
          '</div></div>' +
          '<div class="e2e-link">' +
          '<span class="e2e-chip"><svg viewBox="0 0 24 24" width="13" height="13"><rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>端到端加密</span>' +
          '<svg class="e2e-dash" viewBox="0 0 120 8" preserveAspectRatio="none"><path d="M2 4h116" stroke-dasharray="5 7"/></svg>' +
          '</div>' +
          '<div class="phone">' +
          '<div class="phone-notch"></div>' +
          '<div class="phone-screen">' +
          '<div class="app-head"><div><b>CC Deck</b><span class="app-pc"><i class="dot dot-green"></i>PC-1 · 已连接</span></div><span class="app-count">4 个会话</span></div>' +
          '<div class="app-list">' +
          '<div class="app-row"><i class="dot dot-green"></i><div class="app-row-main"><b>api · 重构登录</b><span>注入指令 · 刚刚</span></div><span class="app-ctx">62%</span></div>' +
          '<div class="app-row app-row-pending"><i class="dot dot-orange"></i><div class="app-row-main"><b>web · 修复表单</b><span>等待审批</span></div><span class="app-badge">审批</span></div>' +
          '<div class="app-row"><i class="dot dot-blue"></i><div class="app-row-main"><b>docs · 整理文档</b><span>运行中 · 3 分钟</span></div><span class="app-ctx">41%</span></div>' +
          '</div>' +
          '<div class="app-approve"><p>Bash <span>npm run test</span></p>' +
          '<div class="app-approve-btns"><span class="t-btn t-btn-yes">✓ 允许</span><span class="t-btn">拒绝</span></div></div>' +
          '<div class="app-input"><span>发消息 / 注入指令…</span><i></i></div>' +
          '</div></div>' +
          '<div class="float-chip fc-a"><svg class="st" viewBox="0 0 24 24" width="14" height="14"><path d="M20 6L9 17l-5-5"/></svg>已远程允许 · oauth.ts</div>' +
          '<div class="float-chip fc-b"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>任务完成 · 手表已轻震</div>' +
          '</div>' +
          '</header>' +
          '<section class="wrap section" id="features">' +
          '<p class="kicker reveal">WHY CC DECK</p>' +
          '<h2 class="reveal" style="--d:.06s">离开电脑，会话不掉线</h2>' +
          '<p class="lead reveal" style="--d:.12s">在 PC 端装一个插件，Claude Code 的会话就实时同步到随身设备。适合把 Claude Code 当主力工作流、离开电脑也不想掉线的开发者。</p>' +
          '<div class="bento">' +
          '<article class="cell cell-wide reveal">' +
          '<div class="cell-text">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="19" height="19"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></div>' +
          '<h3>随身掌控会话</h3>' +
          '<p>多会话实时同步：四态速览、上下文水位、完整转录，断线自动补发不丢帧。</p>' +
          '</div>' +
          '<div class="cell-art sessions">' +
          '<div class="s-row"><i class="dot dot-green"></i><span>api · 重构登录</span><em>运行中</em></div>' +
          '<div class="s-row s-hot"><i class="dot dot-orange"></i><span>web · 修复表单</span><em>等待审批</em></div>' +
          '<div class="s-row"><i class="dot dot-blue"></i><span>docs · 整理文档</span><em>运行中</em></div>' +
          '<div class="s-meter"><span style="width:62%"></span></div>' +
          '<div class="s-cap">上下文水位 · 62%</div>' +
          '</div>' +
          '</article>' +
          '<article class="cell reveal" style="--d:.08s">' +
          '<div class="cell-text">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="19" height="19"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg></div>' +
          '<h3>注入与审批</h3>' +
          '<p>权限审批与提问远程点选；发消息、传图片、远程切模型，随时打断或续聊。</p>' +
          '</div>' +
          '<div class="cell-art approve-art">' +
          '<span class="t-btn t-btn-yes">✓ 允许</span>' +
          '<span class="t-btn">拒绝</span>' +
          '<span class="t-btn t-btn-soft">回一句「先跑测试」</span>' +
          '</div>' +
          '</article>' +
          '<article class="cell reveal">' +
          '<div class="cell-text">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="19" height="19"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></div>' +
          '<h3>任务通知随身</h3>' +
          '<p>任务完成主动汇报：App 通知 + 手表轻震，点按直达；定时任务随身可查。</p>' +
          '</div>' +
          '<div class="cell-art toast-art"><div class="toast"><i class="dot dot-green"></i>任务完成 · 已跑通 12 个测试</div></div>' +
          '</article>' +
          '<article class="cell reveal" style="--d:.08s">' +
          '<div class="cell-text">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="19" height="19"><path d="M12 2.5l7.5 3v5.5c0 4.8-3.1 8.3-7.5 10-4.4-1.7-7.5-5.2-7.5-10V5.5z"/><path d="M9 12l2 2 4-4.5"/></svg></div>' +
          '<h3>端到端加密</h3>' +
          '<p>密钥不出你的设备：LAN 直连不经第三方，云桥只见密文。</p>' +
          '</div>' +
          '<div class="cell-art key-art">' +
          '<span class="kbd">本地密钥</span>' +
          '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12h14M13 6l6 6-6 6"/></svg>' +
          '<span class="kbd kbd-dim">密文</span>' +
          '</div>' +
          '</article>' +
          '<article class="cell reveal" style="--d:.16s">' +
          '<div class="cell-text">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="19" height="19"><rect x="3" y="3.5" width="18" height="7" rx="1.5"/><rect x="3" y="13.5" width="18" height="7" rx="1.5"/><path d="M7 7h.01M7 17h.01"/></svg></div>' +
          '<h3>可自建</h3>' +
          '<p>云桥可自建：Node + ws 与 Cloudflare Worker 两种形态，协议相同；数据只流经你自己的设施。</p>' +
          '</div>' +
          '<div class="cell-art cmd-art">' +
          '<code id="cmd-relay">npx wrangler deploy</code>' +
          '<button class="copy-btn" type="button" data-copy="npx wrangler deploy" aria-label="复制命令">' +
          '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>' +
          '</button>' +
          '</div>' +
          '</article>' +
          '<article class="cell cell-full reveal">' +
          '<div class="cell-text">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="19" height="19"><path d="M12 2l10 5.5L12 13 2 7.5z"/><path d="M2 12.5L12 18l10-5.5"/></svg></div>' +
          '<h3>多源多端</h3>' +
          '<p>四端连入同一个 relay 即可互通；多台 PC 聚合同屏，角标区分来源。</p>' +
          '</div>' +
          '<div class="cell-art platforms">' +
          '<span class="plat"><i class="dot dot-green"></i>Android</span>' +
          '<span class="plat"><i class="dot dot-blue"></i>网页 PWA</span>' +
          '<span class="plat"><i class="dot dot-violet"></i>Windows</span>' +
          '<span class="plat"><i class="dot dot-orange"></i>Wear OS</span>' +
          '</div>' +
          '</article>' +
          '</div>' +
          '</section>' +
          '<section class="wrap section" id="how">' +
          '<p class="kicker reveal">HOW IT WORKS</p>' +
          '<h2 class="reveal" style="--d:.06s">三步接入，端到端加密</h2>' +
          '<div class="steps">' +
          '<div class="step reveal"><span class="step-no">01</span><h3>安装 PC 插件</h3><p>Claude Code 启动时自动带上随身控制台，会话即刻开始同步。</p></div>' +
          '<div class="step-line reveal" aria-hidden="true"></div>' +
          '<div class="step reveal" style="--d:.1s"><span class="step-no">02</span><h3>扫码配对</h3><p>手机扫码或网页输入 6 位配对码；同一局域网自动直连（LAN）。</p></div>' +
          '<div class="step-line reveal" style="--d:.1s" aria-hidden="true"></div>' +
          '<div class="step reveal" style="--d:.2s"><span class="step-no">03</span><h3>随身掌控</h3><p>审批、注入、通知随身影子般跟随，任务跑完主动来汇报。</p></div>' +
          '</div>' +
          '<div class="flow reveal" style="--d:.15s">' +
          '<div class="fnode">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="18" height="18"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></div>' +
          '<b>手机 · 网页 · 桌面 · 手表</b>' +
          '<span>客户端 · 持有密钥</span>' +
          '</div>' +
          '<div class="fhop"><svg viewBox="0 0 46 12" width="46" height="12"><path d="M1 6h40M36 1.5L41 6l-5 4.5"/></svg><span>E2E 加密</span></div>' +
          '<div class="fnode fnode-mid">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a4 4 0 0 0 0-8z"/></svg></div>' +
          '<b>云桥 / LAN</b>' +
          '<span>自建中转 · 只见密文</span>' +
          '</div>' +
          '<div class="fhop"><svg viewBox="0 0 46 12" width="46" height="12"><path d="M1 6h40M36 1.5L41 6l-5 4.5"/></svg><span>密文直达</span></div>' +
          '<div class="fnode">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 17l6-5-6-5"/><path d="M12 19h8"/></svg></div>' +
          '<b>你的电脑</b>' +
          '<span>Claude Code CLI · 持有密钥</span>' +
          '</div>' +
          '</div>' +
          '<p class="cap reveal" style="--d:.2s">密钥只存在于你自己的设备上，中继与公网看到的都只是密文。云桥可自建：Node 与 Cloudflare Worker 两种形态，协议相同。</p>' +
          '</section>' +
          '<section class="wrap section" id="download">' +
          '<p class="kicker reveal">DOWNLOAD</p>' +
          '<h2 class="reveal" style="--d:.06s">下载客户端</h2>' +
          '<p class="lead reveal" style="--d:.12s">当前版本 v0.3.33 · 四端免费开源，连入同一个 relay 即可互通。</p>' +
          '<div class="dl-grid">' +
          '<article class="dl-card reveal">' +
          '<div class="dl-head">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="20" height="20"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg></div>' +
          '<h3>手机 App<span>Android APK · 支持 Wear OS 手表</span></h3>' +
          '</div>' +
          '<p>扫码配对即连：会话速览、远程审批、语音发消息；任务完成推送通知，手表抬腕即看。</p>' +
          '<div class="dl-btns">' +
          '<a class="btn btn-pri" href="https://github.com/humumu130/cc-deck/releases/latest" target="_blank" rel="noopener">前往 GitHub Releases</a>' +
          '<a class="btn btn-ghost btn-sm-block" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">查看源码</a>' +
          '</div>' +
          '</article>' +
          '<article class="dl-card dl-card-hot reveal" style="--d:.08s">' +
          '<span class="dl-flag">推荐</span>' +
          '<div class="dl-head">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="20" height="20"><rect x="2.5" y="4" width="19" height="12.5" rx="2"/><path d="M9 20.5h6M12 16.5v4"/></svg></div>' +
          '<h3>桌面端<span>Windows · v0.3.33 · Tauri 约 3.4MB</span></h3>' +
          '</div>' +
          '<p>轻量原生客户端，托盘常驻、内建更新，与网页端同一套界面。</p>' +
          '<div class="dl-btns">' +
          '<a class="btn btn-pri" href="/dl/cc-deck-desktop-setup.exe">下载 cc-deck-desktop-setup.exe</a>' +
          '<a class="btn btn-ghost btn-sm-block" href="https://github.com/humumu130/cc-deck/releases" target="_blank" rel="noopener">查看全部历史版本</a>' +
          '</div>' +
          '</article>' +
          '<article class="dl-card reveal" style="--d:.16s">' +
          '<div class="dl-head">' +
          '<div class="ic"><svg viewBox="0 0 24 24" width="20" height="20"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14.2 14.2 0 0 1 0 18 14.2 14.2 0 0 1 0-18z"/></svg></div>' +
          '<h3>网页控制台<span>PWA · 免安装 · 全平台</span></h3>' +
          '</div>' +
          '<p>浏览器打开即用，可添加到主屏幕；跨网时输入 6 位配对码即接入。</p>' +
          '<div class="dl-btns">' +
          '<a class="btn btn-pri" href="/app" target="_blank" rel="noopener">打开网页控制台</a>' +
          '<a class="btn btn-ghost btn-sm-block" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">查看源码 · 自行部署</a>' +
          '</div>' +
          '</article>' +
          '</div>' +
          '<p class="note reveal">桌面安装包经 Cloudflare KV 边缘分发；APK 超出 KV 单值上限，走 GitHub Releases。</p>' +
          '</section>' +
          '<section class="wrap section">' +
          '<div class="cta-band reveal">' +
          '<div class="cta-glow" aria-hidden="true"></div>' +
          '<h2>准备好把会话装进口袋了吗？</h2>' +
          '<p>免费开源，扫码即连，数据只流经你自己的设备。</p>' +
          '<div class="hero-cta">' +
          '<a class="btn btn-pri btn-lg" href="#download">下载客户端</a>' +
          '<a class="btn btn-ghost btn-lg" href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">GitHub 查看源码</a>' +
          '</div>' +
          '</div>' +
          '</section>' +
          '<footer class="wrap">' +
          '<div class="foot-brand"><span class="brand-mark brand-mark-sm">CC</span><span>© 2026 CC Deck · MIT License</span></div>' +
          '<div class="foot-links">' +
          '<a href="https://github.com/humumu130/cc-deck" target="_blank" rel="noopener">GitHub</a>' +
          '<a href="https://github.com/humumu130/cc-deck/releases" target="_blank" rel="noopener">Releases</a>' +
          '<a href="https://github.com/humumu130/cc-deck/blob/main/LICENSE" target="_blank" rel="noopener">License</a>' +
          '<a href="/app" target="_blank" rel="noopener">网页控制台</a>' +
          '</div>' +
          '<span class="foot-note">可自建 · 端到端加密中转</span>' +
          '</footer>' +
          '</main>' +
          '<script>' +
          '(() => {\n' +
          '  "use strict";\n' +
          '\n' +
          '  /* ---------- nav: glass background after scroll ---------- */\n' +
          '  const nav = document.getElementById("nav");\n' +
          '  const onScroll = () => {\n' +
          '    nav.classList.toggle("scrolled", window.scrollY > 8);\n' +
          '  };\n' +
          '  onScroll();\n' +
          '  window.addEventListener("scroll", onScroll, { passive: true });\n' +
          '\n' +
          '  /* ---------- reveal on scroll ---------- */\n' +
          '  const revealed = document.querySelectorAll(".reveal");\n' +
          '  if (!("IntersectionObserver" in window)) {\n' +
          '    document.documentElement.classList.add("no-observer");\n' +
          '  } else {\n' +
          '    const io = new IntersectionObserver(\n' +
          '      (entries) => {\n' +
          '        entries.forEach((entry) => {\n' +
          '          if (!entry.isIntersecting) return;\n' +
          '          entry.target.classList.add("in");\n' +
          '          io.unobserve(entry.target);\n' +
          '        });\n' +
          '      },\n' +
          '      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }\n' +
          '    );\n' +
          '    revealed.forEach((el) => io.observe(el));\n' +
          '  }\n' +
          '\n' +
          '  /* ---------- copy install command ---------- */\n' +
          '  const reset = (btn, label) => {\n' +
          '    window.setTimeout(() => {\n' +
          '      btn.classList.remove("done");\n' +
          '      btn.innerHTML = label;\n' +
          '    }, 1600);\n' +
          '  };\n' +
          '\n' +
          '  document.querySelectorAll(".copy-btn[data-copy]").forEach((btn) => {\n' +
          '    const label = btn.innerHTML;\n' +
          '    btn.addEventListener("click", async () => {\n' +
          '      const text = btn.getAttribute("data-copy");\n' +
          '      try {\n' +
          '        await navigator.clipboard.writeText(text);\n' +
          '      } catch {\n' +
          '        const ta = document.createElement("textarea");\n' +
          '        ta.value = text;\n' +
          '        ta.style.position = "fixed";\n' +
          '        ta.style.opacity = "0";\n' +
          '        document.body.appendChild(ta);\n' +
          '        ta.select();\n' +
          '        document.execCommand("copy");\n' +
          '        ta.remove();\n' +
          '      }\n' +
          '      btn.classList.add("done");\n' +
          '      btn.innerHTML =\n' +
          '        \'<svg viewBox="0 0 24 24" width="14" height="14"><path d="M20 6L9 17l-5-5"/></svg>\';\n' +
          '      reset(btn, label);\n' +
          '    });\n' +
          '  });\n' +
          '})();\n' +
          '</script></body></html>',
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
