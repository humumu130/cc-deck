// ---------- 存储态单点画像（DEV-39 清单4 / arch R-3：降级可见性） ----------
// 11-24 事故盲区：sqlite 降级只打进程内 console 横幅（一次性），/health 与 patrol
// 无从得知——生产降级多日才被夜审视出。本模块把存储灰度四键 + 读档 + 降级事实收成
// 一个结构化画像，/health（ws-server）与 patrol（轻探针）两消费面同源，不再各写各的
// 判定。依赖方向：status → session-write → read-mode（无环）；read-mode 的降级台账
// lastSqliteDegradation 是唯一事实源，本层只聚合不另记。
import { basename } from "node:path";
import { currentReadMode, lastSqliteDegradation } from "./read-mode.js";
import { loadSqliteDriver } from "./sqlite.js";
import { sessionWriteMode, bootFromMode } from "./session-write.js";
import { appliedRelayEnvFile } from "../boot-env.js";

export interface StorageStatus {
  /** 配置读档（env/文件解析原值；无效值在此前已 fail-fast，不会出现）。 */
  readMode: "json" | "sqlite" | "shadow";
  /** 实效读档：降级（驱动失败/建库失败）时读面自动落 json（#158 批1 语义）；未降级
   *  =配置档原值（含 shadow——「降级」只谈是否被迫落 json，不重述档位设计）。 */
  effectiveReadMode: "json" | "sqlite" | "shadow";
  /** sqlite 驱动可载性（boot 探测与读入口同源缓存；json 档=不关心，报 "json-mode"）。 */
  driver: "ok" | "failed" | "json-mode";
  /** 降级事实（null=未降级）；与 console 横幅同点写入（read-mode warnSqliteDegradedOnce）。
   *  reason 截断 160 字——/health 无鉴权 LAN 可达，原始驱动错误串可能含本机路径
   *  （审查 P2 处置）；完整串仍在 console 横幅与进程日志。 */
  degraded: { reason: string; code: string | null; context: string; at: number } | null;
  /** session 直写档（缺省 shadow；四步灰度第三键）。 */
  writeMode: "shadow" | "db" | "off";
  /** session 域导入闸（"off"=直写为唯一写者，库行权威；四步灰度第二键）。 */
  sessionImport: "on" | "off";
  /** boot 读源（四步灰度第四键；auto=对账哨）。 */
  bootFrom: "events" | "auto" | "db";
  /** 灰度 env 文件应用记录（file=basename——/health 无鉴权不泄绝对路径，审查 P2
   *  处置；绝对路径排障走进程日志的 [boot-env] 行）。 */
  envFile: { file: string; keys: string[] };
}

/** 存储态画像（每调用现算——/health 每请求一次的轻量取舍，值恒真不缓存）。 */
export function storageStatus(): StorageStatus {
  const readMode = currentReadMode();
  const degraded = lastSqliteDegradation();
  const driver = readMode === "json" ? "json-mode" : (loadSqliteDriver().ok ? "ok" : "failed");
  const envApplied = appliedRelayEnvFile();
  return {
    readMode,
    effectiveReadMode: degraded === null && driver !== "failed" ? readMode : "json",
    driver,
    degraded: degraded === null
      ? null
      : { ...degraded, reason: degraded.reason.length > 160 ? `${degraded.reason.slice(0, 160)}…` : degraded.reason },
    writeMode: sessionWriteMode(),
    sessionImport: process.env.CCR_SESSION_IMPORT === "off" ? "off" : "on",
    bootFrom: bootFromMode(),
    envFile: { file: envApplied.file ? basename(envApplied.file) : "", keys: envApplied.keys },
  };
}
