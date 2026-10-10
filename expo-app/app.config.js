// W-EXPO 阶段一共存骨架（2026-10-09）：APP_VARIANT=nova 出 005 视觉变体的独立
// 包名/应用名配置，与已装 0.6.x CC Deck 共存双装；缺省（环境变量缺失/其他值）
// 原样透传 app.json——原包构建行为零改动。构建侧同一开关见
// android/app/build.gradle 的 APP_VARIANT（-P 或环境变量皆可）。
// W-NOVAVAR B1（2026-10-10）：原生侧已接线——gradle defaultConfig 按同一开关切
// applicationId/app_name（本文件的 package/name 只喂 expo CLI，不参与已提交
// android/ 工程的原生构建；注意本文件只认环境变量，-P 只影响 gradle 侧）。
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const base = JSON.parse(readFileSync(join(__dirname, "app.json"), "utf8"));
const nova = process.env.APP_VARIANT === "nova";

module.exports = nova
  ? {
      ...base,
      expo: {
        ...base.expo,
        name: "CC Deck Nova",
        slug: "cc-deck-nova",
        android: { ...base.expo.android, package: "online.humumu.ccdeck.nova" },
        ios: { ...base.expo.ios, bundleIdentifier: "online.humumu.ccdeck.nova" },
      },
    }
  : base;
