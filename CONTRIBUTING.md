# 贡献指南

## 版本号单一事实源

根目录 `VERSION` 文件。发版只改它，再跑 `node scripts/version.mjs --write` 同步到各落点（web-console `CONSOLE_VERSION`、expo-app `app.json` 与 `build.gradle`、desktop-tauri `package.json`、项目主页三处版本展示）；`--check` 由 git pre-commit 钩子强制校验，不同步的提交直接拦截。

```bash
node scripts/version.mjs           # 查看各落点当前值
node scripts/version.mjs --write   # 发版：把 VERSION 写入全部落点
node scripts/version.mjs --check   # 校验（pre-commit 自动跑）
```

## 开发环境

各端构建与测试命令、仓库布局见 [README「开发」](README.md#开发)。relay 需 Node ≥ 20，测试套件与冒烟脚本在 `relay/` 下。
