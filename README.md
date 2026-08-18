# dsh-session-control

面向 DeepSeek Harness `0.1.0-rc.6` 的受权跨会话控制插件。它把早期动态 `sctrl-1` 原型改造成持久、可审计、可恢复的 Host 插件。

## 安全模型

- **默认无控制者**：`controllerSessionIds` 为空时，不向任何 Agent 注册工具。
- **工具按 Agent scope 注册**：只有显式列出的控制会话看得到 `session_*` 工具，目标会话不会得到这些工具。
- **执行时重复鉴权**：工具可见性只是界面边界；每次执行仍校验精确 controller id、同工作区、普通会话、非 self、非 subagent；投递和运行态管理还要求目标为 live。
- **逐次知情审批**：投递、中断、取消、生命周期管理和正文/工具结果读取都走 `tools/pre-execute → ask`。投递审批理由绑定目标、正文预览、正文 SHA-256 和幂等键。
- **中继降权**：目标系统提示明确把 `<dsh-session-relay>` 视作不受信委派；正文 JSON 会转义 `<`，不能闭合包裹。中继触发的轮次不能调用任何会话控制工具。
- **单向编排**：目标默认没有控制工具；即使目标也是 controller，中继轮也会被 Host 拒绝，阻断 A→B→A 自动循环。

## 工具

| 工具 | 说明 |
| --- | --- |
| `session_status` | 列出同工作区 live 会话，可选包含持久 cold 会话 |
| `session_events` | 默认只读显著事件元数据；正文读取需审批 |
| `session_send` | 审批后幂等投递，返回持久 operation |
| `session_batch_send` | 一次审批分发 1–8 项，创建 batch 父子 operation 图 |
| `session_wait` | 只允许 operation 的来源 controller 等待结果 |
| `session_wait_many` | 同时等待 1–20 个 operation，支持 revision cursor 和需关注状态 |
| `session_interrupt` | 审批后中断当前轮，可等待真正 idle |
| `session_cancel` | 精确取消排队 operation；只中断属于该 operation 的活动轮 |
| `session_open` | 审批后创建、恢复或 fork 同工作区普通会话 |
| `session_manage` | 审批后重命名，或 suspend 本插件持有的会话 |
| `session_operations` | 分页查看来源 controller 自己的持久 operation |

`session_status(include_cold=true)` 可以同时列出同工作区持久 cold 会话。`session_events` 支持 `before_seq` / `after_seq` 分页并可直接读取 cold 历史；工具参数和结果只有在正文审批后才返回。`session_open` 可覆盖 provider、model 和 reasoning effort，覆盖值会先经 DSH LLM Core 精确校验。

## Operation 与恢复

- 使用标准 UUID、正文 SHA-256 和来源绑定幂等键。
- 用 `agent/inbox/claimed` / `agent/inbox/discarded` 的精确消息身份和 `session/event` 的 turn 坐标结算，不猜测任意 splice。
- 状态写入 `stateDir` 下 A/B 双槽 v2 快照；每代 `fsync`，启动时选择最高有效 generation。v1 自动迁移，且两槽均损坏时拒绝启动。
- DSH 重启后从 live Session 或 `sessionPersistence.inspect()` 对未完成 send operation 进行对账；不会自动重发无法确认的消息。被重启打断且无法证明终态的 lifecycle operation 会保留幂等键并转为 `delivery-unknown` / `needs_attention`，不会冒险重复创建或销毁。
- 每次 durable mutation 都有单调 revision；多操作等待和审计分页使用 opaque cursor，已报告状态不会重复唤醒。
- batch 父 operation 根据子 operation 自动汇总为 running、needs-attention、completed、partial、aborted 或 failed。
- 每来源、每目标、每分钟和总 operation 数都有上限；终态 operation 会在容量紧张时按时间淘汰。

## 生命周期边界

- `create`、`resume`、`fork` 使用 DSH Core 的事务化 Agent Factory；preset 在发布前完成组合，失败不会留下半配置 live 会话。
- fork 只截取完整 `turn/end` 边界，并保留 `parentSession` / `seedLength` 血缘。
- 新开会话仍使用相同工作目录，返回 `workspace_isolated=false`；当前 DSH Core 没有供该插件调用的 Git worktree 创建能力。
- `suspend` 只接受本插件当前进程持有 lifecycle handle 的会话，不能销毁其他所有者的 Agent。
- 不提供跨主机 handoff、计划任务或普通会话与 subagent 的统一生命周期；这些仍需要独立 Core 服务。

## 安装

在 DSH profile 目录中从公开 GitHub 仓库安装：

```powershell
pnpm add github:gyyxs88/dsh-session-control
```

然后把 `dsh-session-control` 加入该 profile 的 `dsh.profile.bundles`。生产部署建议固定到已验证的 commit：

```powershell
pnpm add github:gyyxs88/dsh-session-control#<commit-sha>
```

源码仓库：<https://github.com/gyyxs88/dsh-session-control>

## 配置

Bundle 自带配置默认关闭。部署层必须覆盖：

```yaml
- insert:
    - id: authorized-session-control
      name: 'dsh-session-control'
      config:
        controllerSessionIds:
          - session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
        stateDir: 'D:\\path\\to\\.dsh-home\\session-control'
        sameWorkspaceOnly: true
        maxPendingPerTarget: 3
        maxPendingPerSource: 10
        rateLimitPerMinute: 5
        maxOperations: 500
```

当前版本对 cold 普通会话只开放列举、历史读取和经审批的 Core resume；所有写入、投递、中断和管理仍要求目标成为 live。子代理继续使用 DSH 原生 `send_message` / `interrupt_agent`。

## 验证

```powershell
npm test
npm run check
npm pack --dry-run
```

测试覆盖：作用域可见性、同工作区 ACL、中继轮阻断、审批理由绑定、并发幂等、批次父子汇总、cursor 多等待、精确取消、cold 历史分页、Core 创建/fork/suspend、v1→v2 迁移、A/B 状态恢复和损坏双槽 fail-closed。
