# Cloudflare 形态云桥

与 `../cloud-bridge`（Node/Docker）协议完全相同，跑在 Cloudflare Workers +
Durable Object 上（WebSocket Hibernation，空闲不计费）。适合不想维护 VPS 的部署。

## 本地验证（无需账号）

```bash
cd cloudflare
npm install
npm run test:cloud     # 起 wrangler dev + 跑协议冒烟
npm run dev            # 手动起服务 :8791
```

## 部署

```bash
npx wrangler login     # 需要一次浏览器授权
npx wrangler secret put CLOUD_TOKEN   # 设 ≥8 位随机串
# 编辑 wrangler.toml 删掉 [vars] 段（与 secret 同名不能并存）
npx wrangler deploy
```

部署后地址形如 `wss://cc-cloud-bridge.<你的子域>.workers.dev/cloud`，
relay 侧 `CCR_CLOUD_URL` 与手机配对信息里填它（Workers 原生 TLS，无需自备证书）。

注意：workers.dev 域名在部分网络环境下可达性一般；绑定自定义域名可改善。
