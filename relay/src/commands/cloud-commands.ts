// W-SPLIT-S3c：云桥/凭证域命令 mixin（case 体逐字搬出，仅 this.→mgr.）。
// 样板同 S3R2c/S3a（any 网关跨 private/payload 边界；行为等价由
// test-dispatch + check-behavior-parity 锁）。TASK_CREATE/UPDATE/DISPATCH
// 三命令共享一体（board-commands 内单函数，三 case 标签同委托）。
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { devId } from "../e2e.js";
import { isSessionEngine } from "../engine-registry.js";
import { truncate } from "../summarizer.js";
import { sanitizeImportPushEntry } from "../session-manager.js"; // 本地函数（原文件 export 单源）
import type { ImportPushEntry } from "../session-manager.js"; // 类型经 session-manager 转出（org.js 原始定义经其 re-import 链）
export function createCloudCommands(mgr: any) {
  return {
    COMMAND_CLOUD_INFO(cmd: any, by: string): any {
          // #25b（2026-09-10 移动网络场景）：本机 relay 的云桥身份自述——控制台据此
          // 给手机发「本机 relay 的云码」（手机在任何网络可连）。LAN token 鉴权内含
          //（能发命令即受信端）。bt 只给首桥（多桥并发码留待需要时再扩）
          if (!mgr.cloud) {
            return { command_id: cmd.command_id, ok: true, cloudInfo: { cloud: false } };
          }
          return {
            command_id: cmd.command_id,
            ok: true,
            cloudInfo: {
              cloud: true,
              bridge: (mgr.cfg.cloudUrls[0] ?? "").replace(/\/$/, "").replace(/^http/, "ws"),
              bt: mgr.cfg.cloudToken,
              rd: mgr.cloud.relayDev,
              rk: mgr.cloud.keypair.publicKey,
            },
          };
    },
    COMMAND_IMPORT_PUSH(cmd: any, by: string): any {
          // 0.4.4 合并扫码跨网回传：手机把一条连接条目推给出示合并码的网页/exe 端。
          // 校验后交云层密封投递；pusher 返回 false = 目标端离线（码浮层已关/断线）
          const p = cmd.payload as { target_dev?: string; target_pk?: string; entry?: unknown; note?: unknown };
          const dev = String(p.target_dev ?? "");
          const pk = String(p.target_pk ?? "");
          if (!mgr.cloud || !mgr.importPusher) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          if (!/^wb-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pk) || devId(pk, "wb") !== dev) {
            return { command_id: cmd.command_id, ok: false, error: "目标设备参数无效" };
          }
          const entry = sanitizeImportPushEntry(p.entry);
          if (!entry) {
            return { command_id: cmd.command_id, ok: false, error: "回传条目格式无效" };
          }
          if (!mgr.importPusher(dev, pk, { t: "ccdeck-import-resp", entry, ...(p.note ? { note: String(p.note).slice(0, 80) } : {}) })) {
            return { command_id: cmd.command_id, ok: false, error: "电脑端不在线（二维码可能已关闭）" };
          }
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_LOGIN_GRANT(cmd: any, by: string): any {
          // #325 扫码登录：手机（信任信道）授权网页端出示的会话公钥，relay 配对并回 ack。
          // dev 必须与公钥派生值一致（与 pair_req 路径同款校验，防冒名占位）
          const p = cmd.payload as { session_dev?: string; session_pk?: string; name?: string };
          const dev = String(p.session_dev ?? "");
          const pk = String(p.session_pk ?? "");
          if (!mgr.cloud || !mgr.loginGranter) {
            return { command_id: cmd.command_id, ok: false, error: "云桥未启用（PC 侧未设置 CCR_CLOUD_URL）" };
          }
          if (!/^wb-[0-9a-f]{6,64}$/.test(dev) || !/^[A-Za-z0-9+/=]{40,200}$/.test(pk) || devId(pk, "wb") !== dev) {
            return { command_id: cmd.command_id, ok: false, error: "会话参数格式无效" };
          }
          mgr.loginGranter(dev, pk, String(p.name ?? "web").slice(0, 32) || "web");
          return { command_id: cmd.command_id, ok: true };
    },
    COMMAND_WATCH_GRANT(cmd: any, by: string): any {
          // #316 手表配对授权在 ws-server 层处理（持有待配对连接池）；云信道走到这里
          // 说明命令被路由错了——明确报错而非静默
          return { command_id: cmd.command_id, ok: false, error: "手表配对授权仅限局域网信道" };
    },
  };
}
