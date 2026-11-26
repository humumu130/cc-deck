// W-RELDEATH（DEV-18 P0-A 随批）：gh 调用的仓库解析兜底——治 embedded-relay.log 的
// 「failed to run git: fatal: not a git repository」裸错。
// 根因（2026-11-24 生产实锤）：内嵌 relay 由桌面壳孵化，cwd 非 git 仓库；`gh pr list`
// 不带 -R 时 gh 先走 cwd git remote 解析，失败即向继承的 stderr 打一行裸错——落进
// relay 时序日志（当夜 8 条， patrol 拍一条，污染排障视线）。治法：凡无 URL 锚点的
// gh pr 子命令显式带 -R owner/repo，slug 从板卡 pr_url / merged PR URL 解析（纯函数
// 可测）；解析不到回落现状（gh 默认解析，含 GH_REPO/repo set-default 兜底面）。
// 裸 owner/repo 形态刻意不收：与分支名 feat/xxx 同形不可分辨，误认即错仓查询。

/** 从 GitHub URL/remote 提取 owner/repo；https 与 git@ 两种形态，其余返回 null */
export function repoSlugFromGitHubUrl(url: string): string | null {
  const u = url.trim();
  const https = u.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#]|$)/);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = u.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

/** 取首个可解析 URL 的 -R 参数组；全空返回 []（回落 gh 默认解析） */
export function ghRepoFlag(urls: Array<string | undefined | null>): string[] {
  for (const u of urls) {
    if (typeof u !== "string" || !u) continue;
    const slug = repoSlugFromGitHubUrl(u);
    if (slug) return ["-R", slug];
  }
  return [];
}
