#!/bin/bash
# MolStudio 原生回归：从 main.swift 逐字提取真实方法体，用替身跑控制流测试（不启动 GUI）。
# 用法：bash fusion-native/regression/run.sh
# 依赖：python3、swiftc（Xcode 命令行工具）、Node.js。main.swift 改动后重跑即可回归。
set -e
cd "$(dirname "$0")"
OUT_DIR="${OUT_DIR:-/tmp/molstudio-regression}"
export OUT_DIR
mkdir -p "$OUT_DIR"
python3 gen_probe.py
swiftc -module-cache-path "$OUT_DIR/mcache" -o "$OUT_DIR/tests" "$OUT_DIR/probe-tests.swift"
"$OUT_DIR/tests"
node test-snapshot-exports.cjs "$OUT_DIR/fixtures"
