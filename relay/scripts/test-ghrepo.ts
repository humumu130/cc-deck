// W-RELDEATH 随批回归锁：gh-repo.ts 仓库解析纯函数（DEV-18 P0-A——治 embedded-relay.log
// 「failed to run git: fatal: not a git repository」裸错的 -R 兜底）。
// 纯单元：URL 形态解析（https PR/裸仓/.git 后缀/git@ SSH）+ 误认面（分支名 feat/xxx
// 刻意不收——裸 owner/repo 与分支名同形不可辨）+ flag 组装（空串/undefined 跳过、全空回落 []）。
import { repoSlugFromGitHubUrl, ghRepoFlag } from "../src/gh-repo.js";

let pass = 0, fail = 0;
function assert(cond: unknown, name: string) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("FAIL: " + name); }
}

// ── repoSlugFromGitHubUrl：https 形态 ──
assert(repoSlugFromGitHubUrl("https://github.com/humumu130/cc-deck/pull/154") === "humumu130/cc-deck", "https PR URL → owner/repo");
assert(repoSlugFromGitHubUrl("https://github.com/humumu130/cc-deck") === "humumu130/cc-deck", "https 裸仓 URL");
assert(repoSlugFromGitHubUrl("https://github.com/humumu130/cc-deck.git") === "humumu130/cc-deck", ".git 后缀剥除");
assert(repoSlugFromGitHubUrl("https://github.com/humumu130/cc-deck/pull/1#discussion") === "humumu130/cc-deck", "锚点后缀截断");
assert(repoSlugFromGitHubUrl("  https://github.com/humumu130/cc-deck/pull/2  ") === "humumu130/cc-deck", "首尾空白容错");
assert(repoSlugFromGitHubUrl("http://github.com/humumu130/cc-deck") === "humumu130/cc-deck", "http 同收（内网镜像改写形态）");

// ── git@ SSH 形态 ──
assert(repoSlugFromGitHubUrl("git@github.com:humumu130/cc-deck.git") === "humumu130/cc-deck", "git@ SSH + .git");
assert(repoSlugFromGitHubUrl("git@github.com:humumu130/cc-deck") === "humumu130/cc-deck", "git@ SSH 裸");

// ── 误认面（必须 null——防错仓查询）──
assert(repoSlugFromGitHubUrl("feat/engsec-r1") === null, "分支名 feat/xxx 不认（裸 owner/repo 形态刻意不收）");
assert(repoSlugFromGitHubUrl("origin/main") === null, "origin/main 不认");
assert(repoSlugFromGitHubUrl("") === null, "空串不认");
assert(repoSlugFromGitHubUrl("https://gitlab.com/a/b") === null, "非 github 域不认");
assert(repoSlugFromGitHubUrl("https://github.com/") === null, "截断 URL 不认");
assert(repoSlugFromGitHubUrl("/Users/xdd/dev/cc-deck") === null, "本地路径不认");

// ── ghRepoFlag：组装与回落 ──
assert(JSON.stringify(ghRepoFlag(["https://github.com/humumu130/cc-deck/pull/9"])) === JSON.stringify(["-R", "humumu130/cc-deck"]), "单 URL → [-R, slug]");
assert(JSON.stringify(ghRepoFlag([undefined, "", "https://github.com/a/b/pull/1"])) === JSON.stringify(["-R", "a/b"]), "空值跳过取首个有效");
assert(JSON.stringify(ghRepoFlag(["feat/x", "not-a-url"])) === JSON.stringify([]), "全不可解析 → []（回落 gh 默认解析=现状）");
assert(JSON.stringify(ghRepoFlag([])) === JSON.stringify([]), "空数组 → []");

console.log(fail === 0 ? `\nPASS test-ghrepo (${pass} assertions)` : `\nFAIL test-ghrepo: ${fail} failed / ${pass} passed`);
process.exit(fail === 0 ? 0 : 1);
