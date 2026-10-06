#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo test --manifest-path "$ROOT/src-tauri/Cargo.toml" --bin cc-deck-desktop-tauri t1a_probe -- --nocapture
