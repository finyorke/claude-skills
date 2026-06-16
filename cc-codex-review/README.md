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
/cc-codex-review:review [--repo <dir>] [--diff <file|->] [--plan <file>] [--model <m>] [--max-rounds <n>] [--lens <name>] [--dry-run] <评审指令>
/cc-codex-review:extract-reqs [界定指令] [--out <path>]   # 先提取你认证过的需求,再 review --plan 用它当评审基准
```
把要评审的材料粘贴进当前会话,再运行命令。详见 DESIGN.md。

`--lens <name>`(可选焦点镜头,opt-in、单次单镜头):`omission`(首轮遗漏检查,**已验证**,推荐用于提案/设计文档评审)、`security`/`correctness`/`requirements`(**实验性**专项焦点)。镜头是"通用评审+额外侧重",AGREE 仍是全面签核;代码评审默认不套镜头。`--omission-check` 为 `--lens omission` 别名。

`extract-reqs`(需求提取,v0.9.0):从当前会话提取**经你背书的需求(纯 WHAT)**,按"是否经你背书"分三档(纳入/待定/排除)+ fail-closed 硬规则 + 你确认,产出「用户认证需求」供 `review --plan` 当评审基准——让 Codex 对照"你认证的真需求"而非 Claude 单方转述来评审。`[界定指令]` 可选(缺省自动归纳范围、多块/模糊先问你)。详见 `docs/specs/2026-06-12-extract-reqs-design.md`。

## 开发
```
node --test cc-codex-review/tests/*.test.mjs
```
(本机 Node v22 不支持 `--test <目录>` 自动发现,需用上面的 glob 同时跑两个测试文件。)
