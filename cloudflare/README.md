# Cloudflare 形态云桥

与 `../cloud-bridge`（Node/Docker）协议完全相同，跑在 Cloudflare Workers +
Durable Object 上（WebSocket Hibernation，空闲不计费）。适合不想维护 VPS 的部署。

## 公共桥（默认，零配置）

Relay 开箱默认连公共桥 `wss://cc.humumu.online/cloud`——即本 Worker 的公开实例。
桥只见 E2E 密文，设备间按公钥派生 dev id 点对点路由、互不可见；公开 token
仅做准入，连接统一受 Durable Object 内限流保护（总连接 ≤ 600、设备 ≤ 400、
每设备上行 30 帧/s）。自建桥后用 `CCR_CLOUD_URL`/`CCR_CLOUD_TOKEN` 覆盖即可。

## 本地验证（无需账号）

```bash
cd cloudflare
npm install
npm run test:cloud     # 起 wrangler dev + 跑协议冒烟
npm run dev            # 手动起服务 :8791
```

## 自建（约 4 条命令）

```bash
npx wrangler login                        # 需要一次浏览器授权
npx wrangler secret put CLOUD_TOKEN       # 设 ≥8 位随机串（私有 token）
# 编辑 wrangler.toml：改 name 与 routes（或删掉 routes 用默认 workers.dev 域）
npx wrangler deploy
```

可选：`npx wrangler secret put PUBLIC_TOKEN` 设一个公开 token，把自己的桥
开放给别人连（与 `CLOUD_TOKEN` 任一匹配即放行，限流同样生效）——
适合小团队/朋友圈共用，不想自己跑 relay 的用户填你的地址即可。

部署后地址形如 `wss://<你的桥>/cloud`，relay 侧 `CCR_CLOUD_URL` 与手机配对信息里
填它（Workers 原生 TLS，无需自备证书）。

注意：workers.dev 域名在部分网络环境下可达性一般；绑定自定义域名可改善。
