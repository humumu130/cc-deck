#!/usr/bin/env bash
# #018-T2 cargo 侧探针壳：跑 main.rs 内 mod t2_tests（纯函数 + 真 TCP 握手，T1a 同范式）。
# 本机无 cargo 时备案：node 侧 desktop-tauri/tests/t2-probes.mjs 已覆盖等价静态锚点面
# 与动态沙箱拉起面（自包含/协议版本/端口四态实验），t2_tests 属 cargo 环境补位跑法。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cargo test --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin cc-deck-desktop-tauri t2_probe -- --nocapture
