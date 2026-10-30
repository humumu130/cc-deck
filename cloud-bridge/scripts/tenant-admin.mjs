#!/usr/bin/env node
// T1a 租户管理 CLI（桥主/租户主最小操作面——PM 部署与新租户开通用）：
// 直连云桥管理通道（与 relay/网页同协议：{to:"*", data:{t:"tenant_op"}}）。
//
// 用法（先备两个环境变量：桥地址+连接 token；桥主再备 ADMIN_KEY）：
//   CLOUD_URL=wss://cc.example.com/cloud CLOUD_TOKEN=... node tenant-admin.mjs \
//     create-tenant --name 家里                # 桥主：建租户（随发首邀请码）
//     list-tenants                            # 桥主：租户清单
//     seal-tenant --tid t-xxxx                 # 桥主：封租户
//     list-imports                            # 桥主：存量上报待确认清单
//     approve-import --id imp-xxx --tid t-xxx  # 桥主：确认收编入租户
//     list-devices --tenant t-xxxx --dtok ...  # 租户主：本租户设备列表
//     invite --tenant t-xxxx --dtok ...        # 租户主：生成邀请码（15min/一码一设备）
//     kick --tenant t-xxxx --dev ph-xxx --dtok ...  # 租户主：踢出（活线断+同钥拒重入）
//     transfer --tenant t-xxxx --dev rl-xxx --dtok ...  # 租户主：主权转移
//     audit --admin KEY（桥级）| --tenant t-x --dtok ...（租户级）
// 环境变量同读 CLOUD_ADMIN_KEY（--admin 缺省取它）。
import { WebSocket } from "ws";

const [cmd, ...rest] = process.argv.slice(2);
const URL_ = process.env.CLOUD_URL ?? "";
const TOKEN = process.env.CLOUD_TOKEN ?? "";
const ADMIN = rest.includes("--admin") ? rest[rest.indexOf("--admin") + 1] : process.env.CLOUD_ADMIN_KEY ?? "";
const arg = (name) => (rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : undefined);

const OPS = {
  "create-tenant": { op: "tenant-create", args: () => ({ name: arg("name") ?? "unnamed" }), admin: true },
  "list-tenants": { op: "tenant-list", admin: true },
  "seal-tenant": { op: "tenant-seal", args: () => ({ tid: arg("tid") ?? "" }), admin: true },
  "list-imports": { op: "import-list", admin: true },
  "approve-import": { op: "import-approve", args: () => ({ id: arg("id") ?? "", tid: arg("tid") ?? "" }), admin: true },
  "reject-import": { op: "import-reject", args: () => ({ id: arg("id") ?? "" }), admin: true },
  "list-devices": { op: "device-list", args: () => ({ tenant: arg("tenant") ?? "" }), dtok: true },
  invite: { op: "invite-create", args: () => ({ tenant: arg("tenant") ?? "", budget: Number(arg("budget") ?? 1) }), dtok: true },
  kick: { op: "device-kick", args: () => ({ tenant: arg("tenant") ?? "", dev: arg("dev") ?? "" }), dtok: true },
  transfer: { op: "owner-transfer", args: () => ({ tenant: arg("tenant") ?? "", dev: arg("dev") ?? "" }), dtok: true },
  audit: { op: () => (ADMIN ? "bridge-audit" : "tenant-audit"), args: () => ({ tenant: arg("tenant") ?? "" }) },
};

const spec = OPS[cmd];
if (!cmd || !spec || !URL_ || !TOKEN) {
  console.log("用法见文件头注释（子命令：" + Object.keys(OPS).join("/") + "；需 CLOUD_URL+CLOUD_TOKEN）");
  process.exit(2);
}
const opName = typeof spec.op === "function" ? spec.op() : spec.op;
const auth = spec.admin || (spec.dtok === undefined && cmd === "audit" && !!ADMIN)
  ? { admin: ADMIN }
  : { dtok: arg("dtok") ?? "" };

const ws = new WebSocket(`${URL_}?token=${encodeURIComponent(TOKEN)}&dev=tenant-admin-cli`);
const timeout = setTimeout(() => { console.error("超时：桥未回执（检查 CLOUD_URL/CLOUD_TOKEN）"); process.exit(1); }, 15000);
ws.on("open", () => ws.send(JSON.stringify({ to: "*", data: { t: "tenant_op", op: opName, args: spec.args ? spec.args() : {}, auth } })));
ws.on("message", (m) => {
  clearTimeout(timeout);
  const f = JSON.parse(String(m));
  if (f.type === "tenant_op_ok") {
    console.log(JSON.stringify(f, null, 2));
    if (opName === "tenant-create" && f.invite) console.error(`\n→ 首邀请码（明文仅此一次，15min 内交予首登设备=租户主）：\n${f.invite}\n`);
    if (opName === "invite-create" && f.code) console.error(`\n→ 邀请码（明文仅此一次）：${f.code}\n`);
    ws.close();
    process.exit(0);
  }
  console.error(`失败：${f.error ?? JSON.stringify(f)}`);
  ws.close();
  process.exit(1);
});
ws.on("error", (e) => { clearTimeout(timeout); console.error(`连接失败：${e.message}`); process.exit(1); });
