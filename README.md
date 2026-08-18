# dsh-session-control

面向 DeepSeek Harness `0.1.0-rc.6` 的受权跨会话控制插件。它把早期动态 `sctrl-1` 原型改造成持久、可审计、可恢复的 Host 插件。

## 安全模型

- **默认无控制者**：`controllerSessionIds` 为空时，不向任何 Agent 注册工具。
- **工具按 Agent scope 注册**：只有显式列出的控制会话看得到六个 `session_*` 工具，目标会话不会得到这些工具。
- **执行时重复鉴权**：工具可见性只是界面边界；每次执行仍校验精确 controller id、同工作区、live 普通会话、非 self、非 subagent。
- **逐次知情审批**：投递、中断和正文读取都走 `tools/pre-execute → ask`。投递审批理由绑定目标、正文预览、正文 SHA-256 和幂等键。
- **中继降权**：目标系统提示明确把 `<dsh-session-relay>` 视作不受信委派；正文 JSON 会转义 `<`，不能闭合包裹。中继触发的轮次不能调用任何会话控制工具。
- **单向编排**：目标默认没有控制工具；即使目标也是 controller，中继轮也会被 Host 拒绝，阻断 A→B→A 自动循环。

## 工具

| 工具 | 说明 |
| --- | --- |
| `session_status` | 仅列出同工作区 live 普通会话 |
| `session_events` | 默认只读显著事件元数据；正文读取需审批 |
| `session_send` | 审批后幂等投递，返回持久 operation |
| `session_wait` | 只允许 operation 的来源 controller 等待结果 |
| `session_interrupt` | 审批后中断当前轮，可等待真正 idle |
| `session_operations` | 查看来源 controller 自己的持久 operation |

## Operation 与恢复

- 使用标准 UUID、正文 SHA-256 和来源绑定幂等键。
- 用 `agent/inbox/claimed` / `agent/inbox/discarded` 的精确消息身份和 `session/event` 的 turn 坐标结算，不猜测任意 splice。
- 状态写入 `stateDir` 下 A/B 双槽快照；每代 `fsync`，启动时选择最高有效 generation。两槽均损坏时拒绝启动。
- DSH 重启后从 live Session 或 `sessionPersistence.inspect()` 对未完成 operation 进行对账；不会自动重发无法确认的消息。
- 每来源、每目标、每分钟和总 operation 数都有上限；终态 operation 会在容量紧张时按时间淘汰。

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

当前版本刻意只控制 **live 普通会话**。子代理继续使用 DSH 原生 `send_message` / `interrupt_agent`；冷会话不会被半恢复或绕过 Agent preset/model setup。

## 验证

```powershell
npm test
npm run check
npm pack --dry-run
```

测试覆盖：作用域可见性、同工作区 ACL、中继轮阻断、审批理由绑定、幂等、容量、operation 所有权、精确并发队列关联、A/B 状态恢复和损坏双槽 fail-closed。
