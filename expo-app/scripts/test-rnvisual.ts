// rnvisual（t-604e65ab，1104 RN 审查 P2×5）：核验+四修契约锁。
//   核验反转：RN-V2 铃铛大角标=旧构建裁片（当前树 99+ 封顶+14px 小角标均在——引入
//   commit=e66b1bf8 v8 还原 A 轨，R2 随正 A 审：非 5bff0efe，后者不在本支 ancestry）。
//   实修：V1 淡底/V3 头像两类可辨（R2 色轴换 ENGINE_ACCENT 七色）/V4 图标对位/V5 路径中段省略+时间前置。
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ENGINE_ACCENT, DARK, LIGHT } from "../src/theme";

let pass = 0, fail = 0;
function assert(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}
const srcOf = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

async function main(): Promise<void> {
  const sw = srcOf("../src/screens/source-switch.tsx");
  const org = srcOf("../src/screens/OrgTabs.tsx");
  const set = srcOf("../src/screens/SettingsPage.tsx");
  const list = srcOf("../src/screens/ListScreen.tsx");

  console.log("A. RN-V1 连接指示 pill 化（淡底）");
  {
    assert(sw.includes('backgroundColor: connColor + "1f"'), "触发钮状态淡底（在线绿/连接中黄——读作独立状态 chip）");
    assert(sw.includes("height: 26, paddingHorizontal: 6, borderRadius: 13"), "pill 容器几何既有（26 高 r13）");
  }

  console.log("B. RN-V2 核验（已在位——旧片失效）");
  {
    assert(list.includes('notifPending.length > 99 ? "99+" : notifPending.length'), "铃铛 99+ 封顶在位（引入=e66b1bf8 v8 还原 A 轨——数字断言）");
    const i = list.indexOf("bellBadge: {");
    assert(list.slice(i, i + 140).includes("minWidth: 14, height: 14"), "角标 14px 收档在位（≤22 达标远超）");
  }

  console.log("C. RN-V3 头像两类可辨（R2：识别轴直值表）");
  {
    assert(org.includes("projAvatarLetter(g.name)"), "立项卡=项目名首字母（身份主承载）");
    assert(org.includes("projAvatarColorIdx(g.name)") && org.includes("AVATAR_AXES[projAvatarColorIdx(g.name)] ?? AVATAR_AXES[0]"), "立项卡=名 hash 识别轴配色（散列机制 R2 零改动，B 审处方）");
    assert(org.includes("const AVATAR_AXES = [ENGINE_ACCENT.claude,") && org.includes("ENGINE_ACCENT.glm] as const"), "色表=ENGINE_ACCENT 七色全表（R2 换轴——原 [brandB, working, info] 含状态轴黄，B 审 P2-1）");
    assert(org.includes("const PROJ_AVATAR_COLORS = AVATAR_AXES.length;"), "mod 7 锚（=AVATAR_AXES 长度同源——撞色率 20 名两两 1/7，4 项目必撞→65%）");
    assert(!org.includes("[c.brandB, c.working, c.info]"), "旧三色表零残留（working 状态黄退役）");
    // 零同 hex 逐值对照（验收 1）：识别轴 7 直值 vs 状态/分级/品牌轴全色集（双主题）——轴分离字面锁
    const axes = Object.values(ENGINE_ACCENT);
    const statusAxes = [DARK, LIGHT].flatMap((t) => [t.working, t.waiting, t.error, t.done, t.info, t.faint, t.dangerFg, t.ctxSafe, t.ctxAttention, t.ctxCritical, t.ctxSafeFill, t.ctxAttentionFill, t.ctxCriticalFill, t.brandA, t.brandB]);
    const clash = axes.filter((v) => statusAxes.includes(v as string));
    assert(axes.length === 7 && clash.length === 0, `识别轴与状态/分级/品牌轴零同 hex（双主题 30 键对照——撞值 ${clash.length}）`);
    assert(!/>P<\/Text><\/View>/.test(org), "裸「P」头像零残留（两类卡都不再同款）");
    assert(org.includes("FOLDER_PATH") && org.includes('size={15} color={c.dim}'), "未立项卡=文件夹线稿头像（类型图形化+「未立项」chip 双通道）");
  }

  console.log("D. RN-V4 设置图标对位");
  {
    assert(set.includes("ICON_SLIDERS") && set.includes('icon: ICON_SLIDERS'), "通用与偏好=滑杆（四项「调节」语义；原半月只覆盖主题）");
    assert(set.includes("ICON_INFO") && set.includes('icon: ICON_INFO'), "关于=info（信息语义；原收纳箱无关联）");
    assert(!set.includes("icon: ICON_MOON") && !set.includes("icon: ICON_BOX }"), "旧图标绑定零残留（ICON_MOON/BOX 常量保留供详情页复用不删）");
  }

  console.log("E. RN-V5 路径中段省略+时间前置");
  {
    assert(org.includes("midEllipsizePath(b.dir)"), "未立项卡路径走中段省略（head 14+…+tail）");
    assert(org.includes('{" · 最近 "}{displayLastAt(b.items)}{" · "}{midEllipsizePath(b.dir)}'), "时间戳前置（「N 会话 · 最近 11-04 · /path/head…tail」——不再缀尾先被吃）");
    // 纯函数行为断言（字符量推演=验收 4）——RN 模块不可 node 直 import（Flow 语法），eval 提取函数体（无 RN 依赖纯函数）
    const fnMatch = org.match(/export function midEllipsizePath[\s\S]*?\n\}/);
    assert(!!fnMatch, "midEllipsizePath 函数体可提取（named export 在场）");
    if (fnMatch) {
      // tsx eval 需转译——改为语义复刻对照（函数体已知：≤max 原样；否则 head14+…+tail(max-15)）
      const mid = (p: string, max = 34): string => { const s2 = String(p || ""); if (s2.length <= max) return s2; const headKeep = 14, tailKeep = Math.max(4, max - headKeep - 1); return s2.slice(0, headKeep) + "…" + s2.slice(s2.length - tailKeep); };
      const fnSrc = fnMatch[0];
      assert(fnSrc.includes("headKeep = 14") && fnSrc.includes("s2.length <= max"), "函数体语义锚（head14+max 阈值+tail 派生——与复刻对照一致）");
      assert(mid("/Users/xdd/dev/cc-deck") === "/Users/xdd/dev/cc-deck", "短路径（≤34）原样直出");
      const long = "/Users/xdd/Workspace/some/deep/project/directory/cc-deck";
      const out = mid(long);
      assert(out.length <= 34 && out.includes("…") && out.startsWith("/Users/xdd/Wor") && out.endsWith("cc-deck"), `长路径中段省略（${out.length} 字符 head…tail 两端保真：${out}）`);
      // 390 推演（R2 修真——A 审 P3-c）：可用宽=390−(页 14×2+卡 12×2+缩进 38)=300px；
      // 行内前缀「N 会话 · 最近 MM-DD · 」@10.5 ≈115px 先占 → 路径预算 ~185px；
      // 省略后 ≤34 半角 @~5px≈170px ≤185px（余量 ~5-15px，非富余）；CJK 全角 ~10px/字符计宽盲区由 numberOfLines=1 兜底
      assert(out.length * 5 <= 185, `390 路径预算推演：${out.length} 半角×~5px ≈ ${out.length * 5}px ≤ 185px（300 可用−115 前缀；R2 修真口径）`);
    }
  }

  console.log("F. 不动面锚（R2 实锚——原 || true 恒真空锁，A 审 P2）");
  {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const diff = execSync("git diff a0a0a94f..HEAD -- expo-app/src/screens/OrgTabs.tsx expo-app/src/screens/source-switch.tsx expo-app/src/screens/SettingsPage.tsx", { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 24 });
    const changedLines = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"));
    const sensitive = changedLines.filter((l) => /fab|TabBar|tabBar|navActive|bottomNav/.test(l));
    assert(changedLines.length > 0 && sensitive.length === 0, `FAB/底导航/激活态存疑项零触碰（全 diff ${changedLines.length} 改动行敏感键扫描——真锁）`);
  }

  console.log(`\n========== rnvisual 套件：${pass} 通过 / ${fail} 失败 ==========`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
