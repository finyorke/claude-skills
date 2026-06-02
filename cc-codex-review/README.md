# cc-codex-review

Claude × Codex 收敛互审插件:Claude 对某项工作形成主张,Codex 对抗式复核,两方迭代到都 AGREE。

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
node --test cc-codex-review/tests/codex-round.test.mjs
```
