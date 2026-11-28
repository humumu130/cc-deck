# #276 worktree 施工分治认领（避免并行撞车）

- **本会话（fa778d08）**：环境根因层——`relay/scripts/install-hooks.mjs` v2（本地副本挂载+死路径改写，**真机 ~/.claude 已止血：cc-plugins 残留 0/本地挂 7**）+ 新测试 `relay/scripts/test-hookmount.ts` + `relay/package.json` 的 test:hookmount 行。**不碰 relay/src/**。
- **并行会话（认领 relay 侧）**：`relay/src/bridge.ts` 转录 mtime 活性兜底 + test-reclaim/test-alivereclaim/test-alive（含其 Phase 2.5）。
- 两修互补：环境层修「新会话 hook 复活」；relay 层兜「存量 CLI（旧 hook 配置在内存）在终端重启前的活性」。
- test-alive.ts/repro-alive.ts 已被双方先后编辑——归并行会话（其 Phase 2.5 在内），我的断言全部随 test-hookmount.ts 走，不再动这两件。
