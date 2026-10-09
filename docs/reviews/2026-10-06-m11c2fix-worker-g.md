# M11-C2FIX 回单：confirms 格式两吃（J 盲评 P1 阻断处置）

## 缺陷与修法（Leader 拍板①）
生产唯一写者 writeConfirms（projects.ts:625）落盘 `{confirms:[...]}` 包裹形；import-org.ts 原解析只认裸数组→根非数组即 throw→整源 bad-json loss+org_confirm 零导入（波及 G1 双读影子比对）。修法=导入器两吃：根是数组→裸用；对象且有 confirms 数组键→取 .confirms（读法参照 projects.ts:152 取 .groups 同法）；其余形状仍拒（bad-json）。冻结件不格式钦定处从生产现实。

## diff 摘要（三件，分支 feat/matrix-team-m2）
1. `relay/src/storage/import-org.ts`（改 1 段）：confirms 解析段——`JSON.parse` 后 `confirmList` 判定（`Array.isArray(cf)` →裸用；`cf` 为对象且 `Array.isArray(cf.confirms)` →取 `.confirms`；否则 null→throw「根非数组且非 {confirms:[…]} 包裹形」）。后续逐单解析体（missing/kindBad/statusBad/词表/gid 悬空/leader 映射/六字段收窄）零改动——两吃只改「数组从哪来」，映射链一字未动。
2. `relay/scripts/test-import-org.ts`（新增 4.5 段，:145-164）：35→39 断言。
3. `relay/scripts/test-import-org-parity.ts`（J 的件，**仅 fx1 断言段授权面**，52→55 断言；改动面逐条见下节）。
4. package.json 零改动（两脚本已有注册）。

## 两形 fixture 断言说明（验收 1）
- **裸数组形（原样保留）**：test-import-org 前段 fixture 不动，首轮 r1 `counts.orgConfirm===3`（5 单中 3 合法）、幂等 r2 不增、重灌 r3 仍 3——裸数组路径全程未受两吃影响。
- **包裹形（4.5 段新增）**：confirms.json 覆写为 `{confirms:[6 单]}`（=真写路径 writeConfirms 形状）+`utimesSync` 推 mtime（APFS 同毫秒陷阱对策）→重扫：①`rWrap.counts.orgConfirm===4`（3 旧合法单+c-wrap 新单；c-ok 同 id UPSERT 不增行）②c-wrap 逐字段（kind=revive/status=approved/group_id=g-1 归因/title/decided_by===leader.id 映射）——**两吃后映射链无衰减** ③loss 仍 4 账（bad-field×2+dangling-ref+missing-attribution，清旧落新同单同账）④`PRAGMA foreign_key_check` 零行。

## parity fx1 反向改（授权面，改动面逐条列明）
J 的 test-import-org-parity.ts 只动 fx1 断言段+头注，其余（fx2 全部、S1-S6 段、helper、结构）零碰：
1. **头注**：fx1 描述改——原「现状取证=整源 bad-json 零导入」翻转为「F1 修复验收小库：真写路径造包裹形→两吃后全量导入逐字段对表（importOrg 挪终段防污染 fx2 全库对照面）」。
2. **段 1 重构（原 :59-73）**：删同轮 `importOrg(port, fx1)` 调用+`f1`/`f1ConfLoss` 两断言（原「org_confirm=0+bad-json 账」）；保留真写路径造态（createGroup 正经立项+addConfirm suggest-hold）+包裹形现场取证断言（:69「confirms.json 实际格式={confirms:[…]}」）；新增 `f1Expected=listConfirms(fx1)` 旧读面基准定格（2 单）+org.json 落盘（为终段导入备态）。
3. **原 ：73「F1 邻面」断言删除**（引用已删变量 f1 的残留，首版重构 Edit 窗口漏盖致 TS2304）；语义原样挪至终段 rf1 邻面断言（「同轮组/project 照常导入，projects.json 包裹形被正确消费」）。
4. **快进段文案一行改**（原 :247）：「fx1 未经 importOrg 无账，全账仅 fx2 源」——因 importOrg 挪终段，S 段期间 fx1 零账属实。
5. **尾部终段 6 新增（importOrg 前，port.close 前）**：rf1=importOrg(fx1) → 5 断言：全量导入（`orgConfirm===f1Expected.length`，bad-json 整源拒翻案）/邻面（组+project 同轮进）/该源零 loss（bad-json 账随两吃消失）/逐字段对表（照 S4 同法：kind/title/reason/status/created_at/decided_at/decided_by leader 映射/payload_json 深等/group_id 合法 gid 落值）/零悬空 FK。**importOrg 挪终段的原因**：S4 全库对照断言 `SELECT * FROM org_confirm` 长度===oldConfirms.length，fx1 若中途入库必污染。

## ORG_IMPORT_SCHEMA_VERSION 判定：**不 bump**（三理由）
1. **映射输出零变化**：本次只扩展「数组从哪来」的解析入口，同一份数据两形解析后产出的行逐字段一致——schemaVersion 语义是「映射代码升级 bump→全源失效强制重扫」，无映射变化即无 bump 依据。
2. **无存量账需清算**：包裹形旧代码从未成功消费过（整源 throw→事务回滚→checkpoint 从未落盘→下次必重扫）——不存在「旧映射产出的存量账」需要 bump 来强制失效；裸数组源也没有任何账面变化。
3. **bump 纯代价**：全源 checkpoint 失效→下次启动全量重扫，对包裹形源零收益（它们本来就从未 checkpoint 成功过），对裸数组源纯浪费一次重扫。判：不 bump，随映射逻辑真实升级时一并考虑。

## 验收自证
- **tsc 0 错**：最后一次代码 Edit 之后 `npx tsc --noEmit` EXIT=0（/tmp/c2fix-tsc.txt 留痕，全量 0 行——含 E1FIX 教训：申报证据必须是末次 Edit 后的运行）。
- **test:import-org 39/39**（35+4）；**test:import-org-parity 55/55**（52-2+5）；parity 两轮连跑输出**逐字节一致**（/tmp/c2fix-parity-r1.txt vs r2.txt diff 空；fx1 链含 utimesSync 推 mtime 纪律）。
- **十一套回归全绿零退**：storage-driver 21 / storage-migrator 18 / storage-schema 67 / storage-checkpoint 34 / import-org 39 / import-org-parity 55 / import-notification 33 / import-session-task 46 / import-acceptance 38 / import-artifact 37 / duty-boundary 32，全 EXIT=0。
- 跑法 `env -u CCR_TOKEN -u CCR_ORG_DIR -u CCR_DATA_DIR -u CCR_PORT`，生产 8787 与 ~/.cc-deck 零触达；未 commit（待 Leader 核验代提交）。

## 首轮调试记录（诚实留痕）
段 1 重构 Edit 后 tsc 报 parity :73 TS2304（Cannot find name 'f1'）×2——old_string 按 grep 拼就只盖到 :71，原 :73 邻面断言行（引用已删的 f1）成残留。修法：删该行、语义挪终段 rf1 邻面断言。教训：Edit old_string 的 Read 窗口必须盖住改动区+尾行全文，不能靠 grep 拼接。

c2fix done: confirms 两吃(裸数组+{confirms:[…]}包裹形), org_confirm 全量导入+逐字段对表, import-org 39/39+parity 55/55 两轮一致, 十一套回归零退, tsc 0, schemaVersion 不 bump(三理由)
