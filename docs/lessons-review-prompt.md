# LESSONS.md 每晚复盘提示词

你在 remote-agent-hub 仓库里，执行 `docs/LESSONS.md` 的每晚复盘（方法写在 LESSONS.md 第 8 行）。只做复盘这一件事，做完就结束，不开新话题。

## 步骤

1. 读 `docs/LESSONS.md`，取第一行 `<!-- reviewed-through: <sha> (<date>) -->` 里的 sha 作为复盘起点。
2. 列出范围：`git log <sha>..HEAD --no-merges --format='%h|%ad|%s' --date=short`。范围里 0 条 → 什么都不改、不提交，直接结束（回复一句话说明即可）。
3. 范围里只看 `fix`、`revert` 开头的提交，逐条 `git show` 读正文，按三类归位：**修完又返工的、不该合的、验证太糙的**。判断标准是"要是早知道哪条规则，这次返工就不会发生"。
   - fix 提交如果正是 LESSONS.md 已有条目记录的那个问题的**修复动作本身**（该条目的规则或测试就是这次加的），不算新返工，跳过。
   - `feat`/`docs` 提交不看，除非正文说明它在返工旧功能。
4. 归类：与已有条目同类 → 给该条**追加证据行**（commit 短 sha + 一句话），"出现天数"按**不同的日子**计数：同一天多条同类只 +1；跨一天才算新的一天。没有对应条目 → 按现有条目格式新建（规则、为什么、证据、出现天数）。一次性 bug（找不到同类、也说不出会被哪条规则拦住）不记。
5. 升级：某条"出现天数"满 3 天且尚未升级 → 按条目内写的方式执行：该写成一句规则的，加进 `AGENTS.md` 对应小节；能用测试拦住的，补测试并先跑 `npm run typecheck && npm test` 确认通过。**补测试做不到时不要硬写**，在该条目里写 `**待升级**：原因`。
6. 收尾：把第一行更新为 `<!-- reviewed-through: <当前 HEAD 短 sha> (<今天 YYYY-MM-DD>) -->`；在文末追加 `## <日期> 复盘` 一节：范围里共几条、归类结果一行一条（含跳过的及原因）。
7. 提交：
   - 只 `git add docs/LESSONS.md`，以及这次确实改了的 `AGENTS.md` / 测试文件，**都用显式路径**。不要 `git add -A`、不要 `git add .`：同一个 checkout 里可能有别的会话的未提交改动，会一起带进提交。
   - 提交信息第一行以 `docs: lessons review <YYYY-MM-DD>` 开头，正文列本次归类摘要。
   - **不 push** 到任何远端（本仓库规范未要求 push）。
   - 只改了 `docs/LESSONS.md` 就不用跑构建检查；动了 `AGENTS.md` 或测试才跑 `npm run typecheck && npm test && npm run build`。

## 红线

- 不改 `packages/` 下的产品代码；补测试只允许新增/修改测试文件。
- 不 push、不 rebase、不 amend 已有提交、不动别的会话的未提交改动。
- 归类拿不准时，宁可新建一条并写明不确定，不硬塞进已有条目。
