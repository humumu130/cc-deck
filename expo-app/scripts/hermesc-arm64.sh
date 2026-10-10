#!/bin/sh
# 本机（Intel JDK/Rosetta）专用：gradle daemon fork 出的 universal hermesc 会继承
# Rosetta 偏好选 x86_64 切片，触发 macOS Rosetta runtime 死锁（U state 不可杀，
# 2026-09-26 连续复现）。arch -arm64 强制原生切片绕过（Rosetta 进程可跨架构启动
# arm64 子进程）。CI（ubuntu）不会引用本脚本——build.gradle 按存在性条件启用。
cd "$(dirname "$0")/.." || exit 1
HERMESC=$(node --print "require.resolve('hermes-compiler/package.json', { paths: [require.resolve('react-native/package.json')] })" | xargs dirname)/hermesc/osx-bin/hermesc
exec arch -arm64 "$HERMESC" "$@"
