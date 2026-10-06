import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_CAPABILITY_MATRIX,
  ZCODE_DEFAULT_CAPABILITY,
  evaluateCommandPermission,
  evaluateEngineCapability,
} from "../src/org.js";
import { adaptOrgAction, handleOrgActionCreate, type OrgActionCreatePayload } from "../src/projects.js";
import {
  engineProfilesPath,
  preflightEngineProfile,
  readEngineProfiles,
  validateEngineProfile,
  writeEngineProfiles,
  type EngineProfile,
} from "../src/settings.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures", name), "utf8")) as T;
let pass = 0;
let fail = 0;
function check(condition: boolean, message: string): void {
  if (condition) { pass++; console.log(`PASS ${message}`); }
  else { fail++; console.error(`FAIL ${message}`); }
}
function finish(): never {
  console.log(`command business: ${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "ccr-command-business-"));
const errorOf = (result: ReturnType<typeof handleOrgActionCreate>): string => result.ok ? "" : result.error;
try {
  const validOrg = fixture<OrgActionCreatePayload>("command-org-create-valid.json");
  const created = handleOrgActionCreate(validOrg, dataDir);
  check(created.ok === true, "COMMAND_ORG_ACTION=create maps to createGroup");
  if (created.ok) {
    check(created.group.name === "测试团队" && created.group.anchor_dir === validOrg.anchor_dir, "org create preserves name and absolute anchor");
    check(created.needsConfirm === true && created.confirm?.kind === "project-create", "org create returns confirmation shape");
    check(created.confirm?.payload.gid === created.group.id, "confirm payload anchors the created group");
  }
  const invalidAction = fixture<OrgActionCreatePayload>("command-org-action-invalid.json");
  check(errorOf(handleOrgActionCreate(invalidAction, dataDir)).includes("unsupported"), "member actions are explicitly unsupported");
  check(errorOf(handleOrgActionCreate({ ...validOrg, anchor_dir: "relative/path" }, dataDir)).includes("绝对路径"), "relative anchor is rejected");
  check(errorOf(handleOrgActionCreate({ ...validOrg, tier: "member-add" }, dataDir)).includes("tier"), "invalid tier is rejected");
  check(adaptOrgAction({ ...validOrg, anchor_dir: join(dataDir, "alias-anchor") }, dataDir).ok === true, "org action adapter alias uses the same single funnel");

  const validProfile = fixture<EngineProfile>("command-profile-valid.json");
  check(validateEngineProfile(validProfile).ok, "non-secret engine profile validates");
  const writeResult = writeEngineProfiles(dataDir, [validProfile]);
  check(writeResult.ok === true && readEngineProfiles(dataDir)?.[0]?.profile_ref === "profile/example-default", "engine profile write/read round trip");
  const persisted = JSON.parse(readFileSync(engineProfilesPath(dataDir), "utf8")) as { profiles: Record<string, unknown>[] };
  check(!JSON.stringify(persisted).includes("do-not-persist"), "profile file contains no secret fixture value");
  const secretProfile = fixture<unknown>("command-profile-secret.json");
  check(validateEngineProfile(secretProfile).ok === false, "secret-named profile field is rejected");
  const rejectedWrite = writeEngineProfiles(dataDir, [secretProfile]);
  check(rejectedWrite.ok === false && readEngineProfiles(dataDir)?.length === 1, "secret profile write is rejected without replacing existing file");
  const preflightMissing = preflightEngineProfile(validProfile, {});
  check(!preflightMissing.ok && preflightMissing.env_refs.join(",") === "TEST_PROVIDER_KEY,TEST_PROVIDER_BASE_URL", "preflight consumes env reference names only");
  const preflightGood = preflightEngineProfile(validProfile, { TEST_PROVIDER_KEY: "redacted-runtime-value", TEST_PROVIDER_BASE_URL: "https://runtime.example.test/v1" });
  check(preflightGood.ok && preflightGood.env_refs.length === 2 && !JSON.stringify(preflightGood).includes("redacted-runtime-value"), "preflight never returns env secret values");

  const matrix = fixture<{ roles: string[]; capabilities: string[]; allow: Record<string, string[]> }>("command-permission-matrix.json");
  check(COMMAND_CAPABILITY_MATRIX.owner.join("|") === matrix.allow.owner.join("|"), "owner matrix is fixture-locked");
  check(COMMAND_CAPABILITY_MATRIX.operator.join("|") === matrix.allow.operator.join("|"), "operator matrix is fixture-locked");
  check(COMMAND_CAPABILITY_MATRIX.viewer.join("|") === matrix.allow.viewer.join("|"), "viewer matrix is fixture-locked");
  for (const role of matrix.roles as Array<"owner" | "operator" | "viewer">) {
    for (const capability of matrix.capabilities) {
      const result = evaluateCommandPermission(role, capability, { command_id: `${role}-${capability}` });
      const expected = matrix.allow[role]?.includes(capability) === true;
      check(result.allowed === expected, `${role} ${capability} permission=${expected}`);
      if (!expected) check(result.ack?.command_id === `${role}-${capability}` && result.ack?.error === "forbidden" && result.ack.actor_role === role, `${role} ${capability} returns forbidden ACK`);
    }
  }
  check(evaluateCommandPermission("owner", "artifact:batch", { command_id: "batch-owner", capabilities: ["artifact:batch"] }).allowed, "owner artifact batch requires explicit capability");
  check(!evaluateCommandPermission("viewer", "artifact:batch", { command_id: "batch-viewer", capabilities: ["artifact:batch"] }).allowed, "viewer remains read-only for artifact batch");
  check(evaluateCommandPermission("owner", "org:write", "org-command").ack === undefined, "allowed permission has no reject ACK");

  const zcode = fixture<{ engine: "zcode"; default_enabled: boolean; unsupported: boolean; capabilities: string[] }>("command-zcode.json");
  check(ZCODE_DEFAULT_CAPABILITY.engine === zcode.engine && !ZCODE_DEFAULT_CAPABILITY.enabled && ZCODE_DEFAULT_CAPABILITY.unsupported, "ZCode default is disabled and unsupported");
  check(!evaluateEngineCapability("zcode", "profile:write").allowed, "ZCode capability fails closed");
  check(!evaluateCommandPermission("owner", "profile:write", { engine: "zcode", command_id: "zcode-profile" }).allowed, "ZCode profile permission is fail-closed");
  const zcodeProfile = { ...validProfile, engine: "zcode" as const };
  check(!preflightEngineProfile(zcodeProfile, { TEST_PROVIDER_KEY: "x", TEST_PROVIDER_BASE_URL: "https://runtime.example.test" }).ok, "ZCode profile preflight is unsupported");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

finish();
