// W-SWIPEASK 断言锚：AskUser 多问题左右滑切换（#157 后半）——DetailScreen AskBanner
// 源码形态锚（锚实现串防回退；交互行为面走真机录屏验收）。
// 直跑：env -u CCR_ORG_DIR node --import tsx/esm scripts/test-swipeask.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(root, "expo-app/src/screens/DetailScreen.tsx"), "utf-8");

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; console.log("  FAIL " + name); }
}

console.log("== W-SWIPEASK: AskUser 滑切（源码形态锚）==");

// ---- ① 手势核心：PanResponder 捕获阶段 + 横占优锁定 ----
ok(src.includes("onMoveShouldSetPanResponderCapture"), "捕获阶段抢手势（onMoveShouldSetPanResponderCapture——FlatList/父滚动器先占的坑，W-EXPODOMAIN 同款教训）");
ok(src.includes("Math.abs(g.dx) < 24"), "横占优 ≥24px 才启手势（24px 锁定阈值）");
ok(src.includes("Math.abs(g.dx) <= Math.abs(g.dy) * 2"), "纵滑让位判定（|dx| ≤ |dy|×2 不抢——列表滚动/输入框零冲突）");
ok(src.includes("to < 0 || to >= qs.length"), "边界 no-op（首题左滑/末题右滑不启手势）");

// ---- ② 跟手位移：视差 0.35 + 双面插值 ----
ok(src.includes("outputRange: [0, -askDir * 500 * 0.35]"), "当前题跟手视差退（0.35 系数）");
ok(src.includes("outputRange: [askDir * 500, 0]"), "目标题全跟手从侧缘滑入（对向插值）");
ok(src.includes("swipeAskX.setValue(Math.max(0, Math.min(askW(), prog)))"), "跟手进度钳制（0..屏宽，反向拖=回退进度）");

// ---- ③ 松手判定：过半或 vx≥0.55 落位，否则回弹 ----
ok(src.includes("prog >= askW() / 2"), "落位条件①：进度过半");
ok(src.includes("(dir === 1 ? g.vx : -g.vx) <= -0.55"), "落位条件②：甩动速度 vx≥0.55（方向归一）");
ok((src.match(/Animated\.spring\(swipeAskX, \{ toValue: askW\(\)/g) || []).length === 1, "落位 spring（toValue=askW 收满）");
ok((src.match(/Animated\.spring\(swipeAskX, \{ toValue: 0/g) || []).length >= 2, "回弹 spring×2（不足回弹 + terminate 抢占回弹）");
ok(src.includes("setCur(s.to)"), "落位后 setCur(to) 真切换题");
ok(src.includes("onPanResponderTerminate"), "terminate（父抢回）回弹保底");

// ---- ④ 圆点指示条跟手同步 ----
ok(src.includes("Animated.createAnimatedComponent(Pressable)"), "圆点 AnimatedPressable（插值 opacity 须挂 Animated 组件）");
ok(src.includes("outputRange: [1, 0.15]") && src.includes("outputRange: [0.15, 1]"), "圆点淡入淡出对插值（当前点 1→0.15 / 目标点 0.15→1）");
ok(src.includes("i === curQi ? curFade : i === swipeTo ? toFade"), "插值只挂当前/目标两点（其余点不参与）");

// ---- ⑤ 单问题门 + 既有功能不破 ----
ok(src.includes("stepped ? swipeAskPan.panHandlers : {}"), "panHandlers 只挂多问题态（single 无可切换对象零手势）");
ok(src.includes('pointerEvents="none"'), "目标题面 pointerEvents=none（跟手预览不挡当前题作答点击）");
ok((src.match(/onPress=\{\(\) => setCur\(i\)\}/g) || []).length === 1, "圆点点击跳题保留（滑切是增量不是替代）");
ok(src.includes("stepped && swipeTo !== null"), "目标题面仅跟手期渲染（落位后正式渲染接管）");

console.log(`swipeask: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
