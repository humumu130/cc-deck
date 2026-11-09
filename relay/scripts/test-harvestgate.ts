// harvestgate（t-729a598e，1109 三现治本）：leader-harvest 收割 base 链错位收口闸契约锁。
//   三现：#68 merge conflicts 才暴露未进 dev／#70 长期 OPEN 发版缺货／#71 squash 落
//   fix/patrolfix=空笔 877ccaf5。根因=PR base 与记账 pr_base 比对而非意图目标 dev，
//   且 MERGED≠内容进 dev。修=闸一（merge 前 baseRefName==="dev"，--base-override 逃生门）
//   +闸二（squash 后 fetch dev 实证 mergeCommit 在 origin/dev 祖先链）+台账记
//   merge_commit_sha/dev_contains。同步面=repo 副本全量回流（211→586 行同源）+
//   sync-leader-cli.sh 扩双 CLI 分发。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) { pass++; console.log(`  ok ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
}
const REPO = new URL("../..", import.meta.url).pathname;
const rf = (...p: string[]) => readFileSync(REPO + p.join("/"), "utf8");
const hv = rf("cc-plugins/plugins/cc-deck/bin/leader-harvest");
const sync = rf("scripts/sync-leader-cli.sh");

console.log("A. 闸一（merge 前 base=dev 意图校验——三现共同根因收口）");
ok(hv.includes('[ "$ident_base" != "dev" ] && [ "$base_override" != 1 ]'), "A1 意图校验条件在（baseRefName≠dev 且无 override 即拒）");
ok(hv.includes("merge=base-mismatch:"), "A2 拒行 RESULT 形态（base-mismatch:<base>）");
ok(hv.includes("#71 squash 落 fix/patrolfix=空笔 877ccaf5") || hv.includes("877ccaf5"), "A3 三现案例指引在（含 #71 空笔 sha）");
ok(hv.includes("--base-override) base_override=1"), "A4 逃生门参数解析在");
ok(hv.includes("worker 在 dev 基分支追加笔"), "A5 改法指引（R1 链正确形态=同分支追加笔）");

console.log("B. 闸二（squash 后 dev 实证——MERGED≠内容进 dev）");
ok(hv.includes("merge-base --is-ancestor"), "B1 祖先链实证命令在");
ok(hv.includes('hg_dev_contains="no"'), "B2 落错枝检出分支（dev_contains=no）");
ok(hv.includes("cherry-pick -m 1"), "B3 手动救指引（不自动回滚——PM 主权）");
ok(hv.includes("幂等续收路径同过本闸"), "B4 幂等续收（已 MERGED 单）同过闸二");

console.log("C. 台账可审计");
ok(hv.includes('"merge_commit_sha":"%s"') && hv.includes('"dev_contains":"%s"'), "C1 end 行记 merge_commit_sha+dev_contains");
ok(hv.includes('\\"base_override\\":true'), "C2 --base-override 使用时台账记");

console.log("D. 双位同步与分发");
ok(execFileSync("bash", ["-n", REPO + "cc-plugins/plugins/cc-deck/bin/leader-harvest"], { stdio: "pipe" }) !== undefined, "D1 repo 副本 bash -n 过");
ok(hv.split("\n").length > 580, "D2 repo 副本全量回流（211→586+ 两闸；实测行数 " + hv.split("\n").length + "）");
ok(sync.includes("SRC2=") && sync.includes("leader-harvest"), "D3 sync-leader-cli.sh 扩双 CLI 分发");
ok(sync.includes('check_pair "$SRC2" "$DST2" leader-harvest'), "D4 harvest 拒发闸（未回流热改保护）同款");

console.log(`\n========== harvestgate 套件：${pass} 通过 / ${fail} 失败 ==========`);
process.exit(fail > 0 ? 1 : 0);
