// P0-B（DEV-19）：bridge hook（.mjs 运行态文件，不在 tsc 编译面）的纯函数签名——
// 供 scripts/test-hookfail.ts import 类型收口（模块本体见 relay/hooks/bridge-hook.mjs）
declare module "*/bridge-hook.mjs" {
  export function nextState(
    prev: unknown,
    ok: boolean,
    now: number,
    errText?: string | null,
  ): {
    v: number;
    firstFailAt: number;
    lastFailAt: number;
    lastOkAt: number;
    streak: number;
    lastErr: string | null;
    lastWriteAt: number;
  };
  export function shouldWriteState(prev: unknown, next: Record<string, unknown>): boolean;
}
