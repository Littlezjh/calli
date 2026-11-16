# 会话自动推进（第一步）

用户同时跑很多会话，注意力跟不上。目标：每个会话要么在做、要么明确在等某个前提、要么做完；能自己推的不再等人点开。参考了 Persona 的 Agent work state 设计（Triage 规则先行、external 等待定时唤醒、最多 6 次、上限后才找人），把它落成本 hub 自己的协议版：不再另起模型分流，而是复用已有的 `[进度]` 行——agent 说在等什么，hub 就按它说的去推。实现形状照 auto-retry / quota-resume：watch 存 hub 设置、触发前核对事实、谁动了线程就退休。

## 协议

`[进度]` 增加第四种说法（协议词不翻译）：

```
[进度] 等外部：等 CI 跑完，约 10 分钟
```

- 含义：在等不需要用户的外部事件（CI、部署、另一个会话），写明等什么、大约多久。
- 存储上不新增看板列：stage 仍是 `doing`，另带 `wait: { what, minutes? }` 字段；看板照常把它当进行中。`what` 是去掉结尾时长后的那句说明，`minutes` 从「约 10 分钟 / 1 小时 / 5 min」这类写法里解析（写不出来就缺省 10）。
- 注入给 agent 的说明（`<calli-progress>` 块）补了这一句和含义；块里已学过协议的会话不重复注入，agent 照旧写这一行即可。

## 推进规则

一轮正常结束时（`turn.done`、非 cancelled、无待批准/待回答、线程不在跑、没有排队消息），且本轮 agent 报告的是：

- **等外部**：在 `minutes`（夹到 2–240，缺省 10）后发唤醒消息：「你上一轮说在等：X。现在去确认一下：好了就接着做；还没好就说明还要多久。」
  - 唤醒后 agent 又报 等外部：同一链继续，间隔翻倍（上限 60 分钟）；agent 这次写明了新的时长则以新时长为准（仍夹到 2–240）。
  - 同一链最多 6 次唤醒。
- **进行中**：线程稳定 60 秒后发「继续」。同一链最多 3 次。

上限用完：不再发，线程进入「需要你」——助手概况里能看到，说明「自动推进 N 次仍未完成」。之后的处理交回给人：再发消息、重新报告 等外部 会开一条全新的链。

**静默退休**（watch 消失，不发任何消息）：人发了消息、线程被交接/归档/删除、报告变成别的阶段（待验收/需要你/没写进度）、一轮被取消或出错、开关关掉。每次触发前都会重新核对上述事实，以线程自己的最后一轮为准。

**不适用的线程**：助手（Router）自己的会话；协作会话（成员由主控管、成员结果会自动唤醒主控，hub 不便插话）；主动行动自己开的工作会话；导入/终端/后台/control/交接摘要轮。

## 存储与接口

- watch 存 hub 设置 `advance.watches`（同 auto-retry 的做法），daemon 重启后继续；开关存 `advance.settings`，线程覆盖存 `advance.threads`。
- 开关：`GET/PUT /api/advance/settings`（`{ enabled }`，**默认关**；全局关掉时清掉所有 watch）。线程级覆盖照 auto-handover 的写法：`PUT /api/threads/:id/advance`（`enabled: true | false | null`，null 恢复继承；覆盖为关时丢掉该线程的 watch）。
- 线程视图带 `advance: { reason: 'wait' | 'continue', attempts, max, nextAt, what? } | null`；用完上限的链 `nextAt` 为 null。取消：`DELETE /api/threads/:id/advance/watch`。
- 测试杠杆：`CALLI_ADVANCE_MINUTE_MS`（一分钟折算的毫秒）、`CALLI_ADVANCE_CONTINUE_MS`（进行后的稳定时长）、`CALLI_ADVANCE_TICK_MS`（巡检间隔）；假 agent（`test/fixtures/fake-agy.mjs`）的 `FAKE_AGY_ADVANCE` 脚本文件按轮输出 `[进度] 等外部/进行中/…`。

## 助手概况

`personal-context.ts` 增加「已安排」一类：有推进 watch 的会话（note 写等什么、下次几点再看/再发），不再算进「需要你」或「在跑」；用完上限的链算「需要你」，note 写「自动推进 N 次仍未完成」。

## 界面

- 线程里最后一轮下方一行中性小字，与 auto-retry 的「第几次 / 下次几点」同一套样式：「等 CI 跑完 · 14:20 再看 · 取消」/「自动继续 第 1/3 次 · 14:05 · 取消」。取消按钮即 `DELETE …/advance/watch`。
- 设置页「自动交接」里加一行「自动推进」开关（独立保存，不用点上方的保存按钮）。文字进 zh/en/ja。
- 协作、助手与主动行动的会话不出现这一行（不会有 watch）。

## 参考

- Persona `docs/assistant/agent-work.md`（external 等待定时唤醒、翻倍、上限 6 次、上限后找人）：间隔与次数直接沿用；它靠模型分流输出 `wait`，这里改成 agent 自己的 `[进度]` 行，免去一轮模型调用。
- 相对它的取舍：不做 CI 主动轮询（Persona 会先看 PR checks），一律到点让 agent 自己确认——第一步先求简单可靠；不设 risky 等待的安全词拦截，因为本 hub 的唤醒语只让它「确认后接着做」，推送/部署一类动作仍走各自的审批。

## 状态

第一步已实现：协议、推进器（`packages/daemon/src/auto-advance.ts`）、概况、界面、单测与截图验证见 `docs/TODO.md` 对应条目。未做：CI/部署状态的主动轮询（到点由 agent 自查）、协作主控的推进（协作自身已有结果投递，明确排除）、线程级覆盖的界面入口（接口已有，界面待需要时再加）。
