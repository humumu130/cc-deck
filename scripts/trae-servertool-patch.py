#!/usr/bin/env python3
"""W-ENGTRAE-UP（t-c57a99e1，1110）: trae-agent 服务端工具映射补丁——GLM anthropic 兼容层执行面打通。

根因（ENGREST-FIX 考证⑤实锤）：trae_agent/utils/llm_clients/anthropic_client.py 把
bash / str_replace_based_edit_tool 两执行工具硬编码映射为 Anthropic **服务端工具类型**
（ToolBash20250124Param(type="bash_20250124") / TextEditor20250429(type="text_editor_20250429")）。
GLM anthropic 兼容层（4783 代理）不实现服务端工具协议 → tool_use input 恒空 →
arguments={} → bash 侧「No command provided」→ max_steps 10 死循环（trajectory 十步实锤）。

修法：旁路两特判分支，让两工具走该函数本就存在的**泛型 ToolParam 分支**
（name=tool.name + description + input_schema=tool.get_input_schema()——工具类
parameters 自带 command/description 与 path/command/old_str/new_str 等参数定义，
schema 由基类 get_input_schema 生成）。响应侧 content_block.type=="tool_use" →
ToolCall(arguments=input) 为泛型解析，天然兼容。

用法（安装说明）：
  python3 scripts/trae-servertool-patch.py            # 打补丁（幂等：已打则跳过）
  python3 scripts/trae-servertool-patch.py --restore  # 还原原始文件（.orig-bak）
  python3 scripts/trae-servertool-patch.py <path>     # 显式指定 anthropic_client.py
路径解析：argv > $CCR_TRAE_SOURCE > /tmp/trae-agent/trae_agent/utils/llm_clients/anthropic_client.py
（.venv 为 editable 安装——源树文件即运行码，无需重装）。trae 升级/重 clone 后重跑本脚本即可。

锚定策略：按**内容锚**替换（非行号），版本漂移时锚不中即响亮失败（防错位补丁）。
"""
import os
import py_compile
import shutil
import sys

MARKER = "W-ENGTRAE-UP"
ANCHOR_EDIT = '                if tool.name == "str_replace_based_edit_tool":'
ANCHOR_BASH = '                elif tool.name == "bash":'
REPL_EDIT = (
    '                if False and tool.name == "str_replace_based_edit_tool":'
    f"  # {MARKER}: 服务端工具映射旁路（GLM anthropic 兼容层无 server-tool 协议，"
    "走下方泛型 ToolParam+input_schema）"
)
REPL_BASH = (
    '                elif False and tool.name == "bash":'
    f"  # {MARKER}: bash 同旁路（server-tool input 恒空=「No command provided」死循环根因）"
)


def resolve_path(argv_path):
    candidates = [
        argv_path,
        os.environ.get("CCR_TRAE_SOURCE"),
        "/tmp/trae-agent/trae_agent/utils/llm_clients/anthropic_client.py",
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    sys.exit("✗ anthropic_client.py 未找到（传路径参数 / 设 CCR_TRAE_SOURCE / 默认 /tmp/trae-agent 不在）")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    restore = "--restore" in sys.argv
    path = resolve_path(args[0] if args else None)
    bak = path + ".orig-bak"
    src = open(path, encoding="utf-8").read()

    if restore:
        if not os.path.isfile(bak):
            sys.exit(f"✗ 无备份可还原（{bak} 不存在）")
        shutil.copyfile(bak, path)
        py_compile.compile(path, doraise=True)
        print(f"✓ 已还原原始文件：{path}（py_compile 过）")
        return

    if MARKER in src:
        py_compile.compile(path, doraise=True)
        print(f"✓ 已是补丁态（{MARKER} 标记在），跳过——py_compile 复验过")
        return

    if ANCHOR_EDIT not in src or ANCHOR_BASH not in src:
        missing = [a[:44] for a in (ANCHOR_EDIT, ANCHOR_BASH) if a not in src]
        sys.exit(
            "✗ 内容锚未命中（trae 版本漂移？缺：\n  " + "\n  ".join(missing) + "\n）——"
            "请人工核 anthropic_client.py 工具映射段后更新本脚本锚"
        )

    if not os.path.isfile(bak):
        shutil.copyfile(path, bak)
        print(f"✓ 原始文件备份 → {bak}")
    patched = src.replace(ANCHOR_EDIT, REPL_EDIT, 1).replace(ANCHOR_BASH, REPL_BASH, 1)
    open(path, "w", encoding="utf-8").write(patched)
    py_compile.compile(path, doraise=True)
    print(f"✓ 补丁已打（{path}）：两服务端工具特判旁路 → 泛型 ToolParam+input_schema；py_compile 过")
    print("  复测：bash 真执行 + edit 真写文件 + trajectory 无空参步（见 w-engtraeup.md 回执）")


if __name__ == "__main__":
    main()
