# cc-codex-review

Claude × Codex 收敛互审插件:Claude 对某项工作形成主张,Codex 对抗式复核,两方迭代收敛于都 AGREE;未收敛(默认满 5 轮或停滞)则产出结构化 UNRESOLVED 交人工裁决。`--max-rounds <n>` 可调上限(`0`=不设)。

## 安装
```
claude plugin marketplace add finyorke/claude-skills   # 或已加则刷新
claude plugin install cc-codex-review@fun-plugins
```
需本机已安装并登录 Codex CLI(否则命令会提示运行 `/codex:setup`)。

## 用法
```
/cc-codex-review:review [--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--dry-run] <评审指令>
```
把要评审的材料粘贴进当前会话,再运行命令。详见 DESIGN.md。

## 开发
```
node --test cc-codex-review/tests/*.test.mjs
```
(本机 Node v22 不支持 `--test <目录>` 自动发现,需用上面的 glob 同时跑两个测试文件。)
