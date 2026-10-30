// Node 自部署桥租户存储：本地 JSON 文件（PRD §4.5——同 relay org 文件域惯例）。
// 写时备份（PRD §7 风险表「Node 桥名册文件损坏」缓解）：save 前把现库拷 .bak，
// 损坏时人工恢复；tmp+rename 原子写防半写。整库小规模（数十设备），全量读写。
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import type { TenantDb, TenantStore } from "./tenant.js";

export class FileStore implements TenantStore {
  constructor(private path: string) {}

  async load(): Promise<TenantDb | null> {
    try {
      if (!existsSync(this.path)) return null;
      const db = JSON.parse(readFileSync(this.path, "utf-8")) as TenantDb;
      if (db.v !== 1) throw new Error(`unsupported db v=${db.v}`);
      return db;
    } catch (e) {
      console.log(`[tenant] file store load failed (try .bak): ${e}`);
      try {
        const db = JSON.parse(readFileSync(this.path + ".bak", "utf-8")) as TenantDb;
        if (db.v === 1) return db;
      } catch { /* bak 也坏——空库起 */ }
      return null;
    }
  }

  async save(db: TenantDb): Promise<void> {
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(db));
    if (existsSync(this.path)) {
      try {
        copyFileSync(this.path, this.path + ".bak");
      } catch { /* 备份失败不阻断主写 */ }
    }
    renameSync(tmp, this.path);
  }
}
