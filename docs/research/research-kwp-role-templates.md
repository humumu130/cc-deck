# KWP-D 岗位模板库专项设计（多路之四·2026-10-10）

> 输入：/tmp/kwp-lead（anthropics/knowledge-work-plugins，18 岗位 252 技能，只读）× cc-deck relay 注入链路（只读本仓）。
> 硬约束（用户已拍板）：岗位范式翻译进 **relay 层 wrapDispatchPrompt 注入行**，全引擎对齐，不依赖 Claude Code 宿主的 SKILL.md/斜杠命令机制。
> 参考：Leader 精读 research-kwp-lead.md（其第 3 条判断「岗位=技能包模板库与 #37 天然衔接」本文展开为具体 schema）。

---

## 一、岗位知识解剖（三岗抽样）

### 1.1 KWP 结构实录

每岗位（plugin）= `plugin.json`（清单四行：name/version/description/author，无岗位元数据）+ `skills/`（知识主体）+ `commands/`（斜杠命令，多数岗位已并入 skills）+ CONNECTORS.md。岗位定义的薄清单说明：**KWP 的「岗位」不在 manifest 里，在 SKILL.md 集合本身**——岗位 = 一组领域知识包的聚合名。

### 1.2 三岗精读

| 岗位 | 精读技能 | 知识形态 |
|---|---|---|
| engineering | code-review / architecture / debug | 检查维度清单（安全/性能/正确性/可维护性四维各 5-6 子项）、ADR 输出模板、debug 四步工作流（REPRODUCE→ISOLATE→DIAGNOSE→FIX） |
| product-management | write-spec / stakeholder-update | PRD 八段结构、MoSCoW 分级判断标准（「如果全 P0 等于没有 P0」）、G/Y/R 状态纪律（「黄不是失败，是风险管理」）、ROAM 风险框架、按受众五档汇报模板 |
| marketing | brand-review | 品牌审查维度（voice/术语/信息支柱/风格合规）、voice 光谱表（正式↔随意等 7 轴）、按渠道 tone 适配表、法律合规旗标（无据断言/缺免责/对比宣称） |

引用路径（均 /tmp/kwp-lead 下）：`engineering/skills/code-review/SKILL.md`、`engineering/skills/debug/SKILL.md`、`product-management/skills/write-spec/SKILL.md`、`product-management/skills/stakeholder-update/SKILL.md`、`marketing/skills/brand-review/SKILL.md`。

### 1.3 岗位知识的原子结构（八种原子，翻译时各有着落）

1. **触发语义**（frontmatter description 的触发词）→ 翻译时**丢弃**：relay 无技能触发机制，派单任务书即触发。
2. **工作流步骤**（How It Works / Workflow）→ **岗位纪律行**（有序步骤压成一行）。
3. **检查维度清单**（Review Dimensions）→ **质量基线行**（维度名+判断锚点）。
4. **领域框架**（MoSCoW / INVEST / G-Y-R / ROAM / voice spectrum）→ **一行黑话+判断标准**（框架名必须带「什么时候用哪个档」的一句锚点，光报名字没用）。
5. **输出模板**（Output format / ADR 格式）→ 大部分**丢弃**（worker 回执格式已由派单纪律统一管），只把「交付物必含哪些段」提炼为**产出结构行**。
6. **反模式/常见错误**（Common Mistakes / Tips）→ **禁则行**。
7. **受众适配变体**（stakeholder-update 五档受众）→ **丢弃**：cc-deck worker 汇报对象恒为 Leader/用户，无多受众场景。
8. **连接器条件增强**（If X connected）→ **丢弃**：对应引擎能力差异，归 agent-adapter 层，不进岗位行。

另有两个横切发现：
- **岗位级行为规则块**（sales/skills/rep-context/SKILL.md 开头的 Rules 块，「apply to every step」）——不受触发语义约束、对该岗位所有任务恒成立的规则。这正是「岗位行」的形态学原型：KWP 用它装安全纪律与兜底策略，我们用它装岗位方法论铁律。
- **可定制占位符**（cowork-plugin-management/skills/cowork-plugin-customizer/SKILL.md 的 `~~Jira` 机制）——模板文件里 `~~` 前缀标记公司定制点，定制工具替换为真值，且**铁律「绝不改插件/技能名」**（内容可改、slug 不可改）。维护面直接借鉴（见 §六）。

---

## 二、翻译设计：三形态评估

任务书给的三个候选，逐一过 cc-deck 现实：

### 形态①：org.json 的 role_defaults 扩展（岗位→注入行模板）

role_defaults 现状（`relay/src/projects.ts:36-40`）只有 engine/model/provider 三键，消费点 `session-manager.ts:5909`（`group?.role_defaults?.[role]`）。

- ✅ 改动最小，消费链路已按 role 索引取值。
- ❌ role_defaults 是**每组建制**的组成部分——同一岗位在 10 个组里要重复写 10 遍，无单点维护、无版本、无预置库可言；org.json 会随岗位知识膨胀。**只配当覆盖层，不配当库。**

### 形态②：org/ 岗位预设库文件（岗位定义 json，建团选岗即装）✅ 推荐·主体

`<orgDir>/role-templates.json`：岗位模板库作为**用户可见团队资产**落 org/ 域（与经验库 experience.json 同选址哲学——experience.ts 头注「org 目录 = 组织资产家」）。

- ✅ 单点维护跨组复用；org/ 域既有惯例全套适用（用户可手编、不进 data/ 不进 artifacts/）。
- ✅ 与 #37 智能建团天然衔接：PM 生成编制输出 role 名 → 建团面从库选岗 → 派单自动带岗位行。
- ✅ 内置预置（随 relay 发版）与用户覆盖（org/ 手改）可以干净分层（见 §六）。
- ⚠ 需处理引用悬空：组里挂了 role 名、模板被删 → **fail-open**（无岗位行照派 + warn），因为这是知识轴不是权限轴（见 §四）。

### 形态③：经验库预置条目（岗位名做 role_scope）❌ 不推荐做主体

表面上看零新机制（role_scope 本就是自由字符串，experience.ts:49 注释明确「role 值域现实是自由字符串，fail-open」），但语义冲突是结构性的：

- **GC 会杀岗位知识**：机械档 90d 从未命中自动 retire（experience.ts §3.3.2）——岗位方法论低频岗位半年不用就被清掉，retire 语义对「学到的经验」合理，对「给定方法论」荒谬。
- **200 字上限装不下**：经验条目 text ≤200 字（parseExperienceDeclaration 同口径），write-spec 一篇 251 行的手册压不进。
- **kind 词表错位**：pitfall/practice/preference/fact 四类是为「回流经验」设计的，表达不了「工作流/检查清单/输出结构」。
- 混库还污染 GC 归一键去重（岗位行和经验行文本相近时被误收编）。

**正确关系**：③不是主体，但岗位**使用中申报的经验**天然以 role_scope=岗位名沉淀——岗位模板行与经验行在注入端**分节共存**（模板节恒注、经验节按权重/memo），来源分明互不越界。

### 推荐结构：②库 + ①覆盖，③只做经验沉淀语义

```
内置库（relay 仓库 presets/role-templates.json，随发版更新）
        ↓ 首次建团选岗时实例化 / 用户可随时手改
用户库（<orgDir>/role-templates.json，用户地盘，同名 slug 用户版优先）
        ↓
org.json 的 headcount[].role / role_defaults —— role 名即库的引用键
        ↓
dispatchWorker → buildRoleInjection(role, anchor) → wrapDispatchPrompt 第四参
```

---

## 三、注入设计（预算与格式）

### 3.1 注入行 schema 提案

```jsonc
// <orgDir>/role-templates.json
{
  "schema_version": 1,
  "templates": [
    {
      "slug": "engineering-dev",            // 引用键，小写短横线；铁律：不可改（customizer 纪律）
      "name": "开发工程师",                   // 审批界面/选岗列表显示名
      "summary": "按派单完成设计/实现/自测闭环", // 一句话使命（审批摘要 + 无预算时的降级行）
      "engine": "claude",                    // 可选：岗位引擎缺省（比 role_defaults 更早的缺省层）
      "model": null,
      "lines": [                             // 注入行集，每行 ≤120 字，建议 5-8 行
        "缺陷修复先复现再定位：…",
        "…"
      ],
      "source": "builtin" | "user",          // 内置实例化后转 user（ thereafter 归用户地盘）
      "base_version": "0.7.0",               // source=builtin 时的内置库版本锚（升级比对用）
      "updated_at": 1728500000000
    }
  ]
}
```

### 3.2 注入格式与预算

wrapDispatchPrompt（`session-manager.ts:7003`）扩展第四参 `roleBlock`：

```
[tier 派单]
<task>
—— 岗位纪律（<name>）——            ← 新增节，恒在（有模板才在）
<lines…>
—— 团队经验（N 条…）——            ← 现有经验节，不动
—— 派单纪律 ——
…
```

预算三条硬数字：
- 经验块现状 700 字符（`CCR_EXP_INJECT_BUDGET`，experience.ts:95）**不动**。
- 岗位块新设独立预算 **600 字符**（`CCR_ROLE_INJECT_BUDGET`，同款 env 纯函数），裁剪算法复用 selectForInjection 的「贪心装满、整块恒 ≤ 预算」性质（经验行超预算跳过继续试更短者的逻辑同款；岗位行按行序取，超预算截断到整行）。
- 首单最坏总注入 ≈ 纪律 300 + 岗位 600 + 经验 700 ≈ 1600 字符，相对派单任务本身可接受；熟手 resume 侧岗位行与经验行同样走 session memo 防重注（**memo 键掺入模板 updated_at——模板改版视为新内容允许重注**，这是与经验 memo 的唯一差异）。

### 3.3 全引擎对齐（硬约束落点）

岗位行进的是 wrapDispatchPrompt 文本包装——它位于引擎适配层**上游**，Claude/Codex/GLM 等任何引擎收到的首条输入同构，天然满足「不依赖 CC 宿主 SKILL.md 机制」约束。引擎差异（如某引擎不支持某工具）仍归 agent-adapter 预检/policy 层，岗位行里不写引擎条件分支。

---

## 四、与智能建团（#37）的衔接

### 4.1 权限轴 / 知识轴正交（本设计最关键的一条判定）

现有 bizRole 映射（`session-manager.ts:5999`）是**权限语义**：worker/team_pm/review_pm 三值词表，词表外 fail-closed 拒派（P81-5「零静默升权」）。这个 fail-closed **必须保持不动**。

岗位模板库是**知识语义**：role 名可以千变万化（"前端工程师"/"质检员"/"文案"）。两条轴的映射关系：

- **知识轴 fail-open**：role 名在模板库无命中 → 无岗位行照派 + 审计 warn（与经验注入「任何抛错→无注入派单照发」同契约，experience.ts:609 REL 建-8③）。
- **权限轴 fail-closed**：bizRole 推导逻辑不变——岗位模板的 `perm` 字段（见 §4.2）**只能收窄不能放宽**，放宽请求照旧走 permission 求值闸拒绝。

这样 PM 建团时可以自由发明岗位名，不会撞权限词表的墙；权限收紧依旧零静默。

### 4.2 编制生成 → 选岗 → 审批的链路

1. **PM 生成编制**：输出每个成员的 `{role, 职责描述}` → PM（或建团面）按职责描述在模板库匹配 slug（内置库命中 → 直接挂；无命中 → 以「无岗位行」建组，PM 的职责描述作为 lines 存为 user 模板——**PM 生成岗位 = 库的自动扩充来源**，这是 KWP「组织沉淀自己的插件」哲学的对位物）。
2. **用户审批界面展示**（每岗一卡）：
   - 岗位名 + summary 一句话使命；
   - 注入行数与**前 3 行预览**（超过折叠「展开全部 N 行」——更新弹窗军规同款交互）；
   - 引擎/模型缺省（role_defaults 合成后的生效值）；
   - 权限档（bizRole 推导结果，只读展示）；
   - 来源角标（内置模板 vX / PM 新拟 / 用户自定义）。
3. **动态扩缩容**：扩编 = 同 slug 选岗即装（无重复配置）；缩编 = 移 headcount 条目，模板无引用计数负担（库与组是松耦合的按名引用，删组不动库）。

---

## 五、内容素材盘点（252 技能 × cc-deck 用户画像）

用户画像：开发者/小团队。逐岗位适配判定：

| 岗位 | 技能数 | 适配 | 第一批候选技能（可提炼注入行的） |
|---|---|---|---|
| engineering | 10 | ★★★ 全命中 | 全部（debug/code-review/testing-strategy/architecture/documentation/tech-debt/standup/deploy-checklist/incident-response/system-design） |
| data | 10 | ★★★ 高 | write-query/analyze/validate-data/statistical-analysis（SQL+分析是开发者日常） |
| product-management | 8 | ★★★ 高 | write-spec/stakeholder-update/metrics-review/competitive-brief（小团队 PM 多为兼任，方法论收益最大） |
| operations | 9 | ★★ 中高 | runbook/process-doc/status-report/risk-assessment（小团队流程资产） |
| design | 7 | ★★ 中 | design-critique/ux-copy/accessibility-review（配合 impeccable 现有 skill 生态） |
| marketing | 8 | ★★ 中 | brand-review/content-creation/performance-report |
| customer-support | 5 | ★ 中低 | ticket-triage/draft-response |
| productivity | 4 | ✗ 不借 | 与 cc-deck 任务/经验体系功能重叠（Leader 报告同判），只借鉴其两层记忆的组织思想 |
| sales(35)/small-business(40+)/legal/finance/hr/bio/enterprise-search | — | ✗ 暂缓 | 面向正规职能团队，开发者画像弱相关；库结构预留 slug 扩位即可 |

### 第一批翻译：3 岗 18 行样例（预算内 5-8 行/岗，行 ≤120 字）

**engineering-dev（开发工程师）**
```
- 缺陷先复现再改：隔离变量→形成假设→验证假设→定位根因；禁止凭猜测直改。
- 提交前按四维自查：安全（注入/凭据/越权）、性能（N+1/复杂度/泄漏）、正确性（边界/并发/错误传播）、可维护性（命名/职责/重复）。
- 修复必带防回归：补测试或守护断言，回执注明验证方式。
- 新增依赖/环境变量/数据迁移等配置面变更，回执显式列出。
- 结论先行：根因一句话在前，证据过程在后。
```

**pm（产品经理）**
```
- 规格必含四段：问题（2-3 句+证据）/目标（3-5 个可测结果）/非目标（显式排除+理由）/验收标准（前置-动作-预期）。
- 需求分级 MoSCoW：P0=砍掉它核心问题就无解；如果全是 P0 说明分级失败，重新质询。
- 进度状态三色如实：黄=风险已现但可控（早报优于晚报，黄不是失败）；红=需要升级决策。
- 每条风险四件套：风险+影响+可能性+缓解；带不出缓解就明说要什么帮助。
- 汇报结论先行：先结果与指标变化，再讲过程。
```

**content-marketing（内容营销）**
```
- 品牌声音一致性优先于文采：同一概念全篇同一用词，不换同义词。
- 禁无据断言：最高级/比较级宣称须有数据出处或加限定词。
- 渠道定调：正式渠道克制（少感叹号/禁全大写）；社媒可直给但不轻浮。
- 交付前自查分档：违声音或合规风险必改，前后不一致应改，风格偏好可留。
- 写用户语言：不写内部术语与任务号，写用户能做成什么。
```

（data 岗位第二批；每岗翻译时同法炮制：检查清单→基线行、工作流→纪律行、框架→锚点行、反模式→禁则行。）

---

## 六、维护面：版本化与用户自定义

### 6.1 内置/用户双层（对位 KWP 的「generic template → 公司定制」）

- **内置库**：`relay/presets/role-templates.json` 入仓随发版（首批 3 岗即 §五样例）；schema_version 升级时老用户库不自动覆盖（用户地盘纪律）。
- **用户库**：org/role-templates.json。内置条目首次被选岗/被 PM 引用时实例化落盘（source: builtin → 标 base_version），此后用户随意改——KWP customizer 的铁律照搬：**内容可改、slug/name 不可改**（改 slug = 断所有组的引用）。
- 内置库发新版时：用户库同 slug 条目 base_version 落后 → 建团选岗界面给「有新版可参考」角标（不静默覆盖、不强制升级——与 duty_policy「已有显式配置不被迁移覆盖」同哲学）。

### 6.2 版本化

- schema_version（库级，破坏性迁移锚）+ updated_at（模板级，memo 失效锚）+ base_version（溯源锚）三层够用；不做逐行版本（org 资产粒度到模板即可，行级历史 git 管不了、经验库也只到条目级）。
- `~~` 占位符机制**暂不引入**：KWP 的占位符服务「不懂技术的定制流程」，cc-deck 用户直接手编 org 文件（org 域既有惯例）+ PM 自动拟岗已覆盖定制需求；若将来做「公司行话批量替换」（如把模板里的「代码评审」换成公司黑话）再考虑，记入开放问题。

---

## 七、改动面清单（实现时按此拆任务）

| # | 文件 | 改动 | 规模 |
|---|---|---|---|
| 1 | `relay/src/role-templates.ts` **新件** | store（load/save 原子写+坏 JSON 防御，experience.ts 同范式）+ 内置库实例化合并 + buildRoleInjection(role, anchor) 纯函数（预算裁剪恒 ≤600） | 中 |
| 2 | `relay/presets/role-templates.json` **新件** | 内置库首批 3 岗（§五 18 行样例） | 小 |
| 3 | `relay/src/session-manager.ts` | dispatchWorker 内 role 解析后接 buildRoleInjection；wrapDispatchPrompt 加第四参 roleBlock（签名改导出，测试断言同步）；7003 行函数 + memo 掺 updated_at | 小（挂点多改面窄） |
| 4 | `relay/src/experience.ts` | 无改（经验 memo 与岗位 memo 分键即可，注入端两块独立拼装） | 零 |
| 5 | `relay/src/projects.ts` | 零 schema 变更（role 名即引用键）；仅类型注释补「role 可挂 role-templates 库」说明 | 极小 |
| 6 | relay API | `GET /api/role-templates`（库列表，建团面选岗用）+ 现有 org create/dispatch 无入参变更 | 小 |
| 7 | 测试 | role-templates store 断言（原子写/坏 JSON/内置合并）+ 注入格式断言（含预算截断/失败降级无注入照派）+ 权限轴不受岗位行影响断言 | 中 |

环境变量：`CCR_ROLE_INJECT_BUDGET`（缺省 600）、`CCR_ROLE_TEMPLATES`（总开关，缺省 true，对齐 experience 开关范式——关=无岗位行照派零残留）。

---

## 八、风险与开放问题

1. **岗位行 vs 派单纪律的从属关系**：岗位行里若与派单纪律冲突（如岗位行说「逐动作汇报」）以谁为准？建议派单纪律恒后置且加一行「纪律优先于岗位行」，实现时在 BLOCK 尾注即可。待拍板。
2. **PM 拟岗质量**：PM 自动生成的 lines 可能注水（空泛行占预算）。首批用「PM 拟岗必须 ≤6 行、每行 ≤120 字」的生成约束压住；审批界面让人眼过一遍是最终防线。
3. **多语言**：内置库样例按中文写（cc-deck 注入语境全中文）；将来社区岗位库若多语言，slug 恒英文、lines 按库语言。P2。
4. **small-business 的「smb-router」模式**（一技能路由到 40 技能）是另一种岗位组织法（入口岗位→内部转包），与我们 Leader 派单同构——本次不吸收，但其「岗位间路由表」思想若将来做跨组协作可回顾 `/tmp/kwp-lead/small-business/skills/smb-router/SKILL.md`。
5. **经验块与岗位块的注入顺序**：本设计岗位行在前（方法论先于教训）——理由：教训是方法的例外，先立法后释例。若实测发现经验行被岗位行挤出注意力，可对调，env 不控顺序只控预算。

---

## 附：与本设计相交的既有资产

- `~/.cc-deck/artifacts/design-role-experience-reflux.md`（经验回流设计 §5.1 注入挂点——本设计的岗位块与它共用 wrapDispatchPrompt 包装位）
- `docs/design/team-mode-design.md:385`（身份注入三件套 team_id/role/身份——M1 已落 spawn 参数形态）
- Leader 精读 research-kwp-lead.md 第 3 条（岗位=技能包模板库，本文是其 schema 化）
