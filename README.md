# dsh-session-control

面向 DeepSeek Harness `0.1.0-rc.6` 至 `0.1.1-rc.2` 的受权跨会话控制插件。它把早期动态 `sctrl-1` 原型改造成持久、可审计、可恢复的 Host 插件。

## 远程项目设计

本插件继续保持单个 DSH Host 内的会话、工作区、权限、审批和定时语义。SSH 主机接入、远端 DSH 自动部署、本机 Model Gateway、插件选择性同步，以及 Codex、Claude Code、Grok Build 的按需远端运行时设计，见 [DSH 远程项目、模型网关与 Agent 运行时架构](docs/remote-project-architecture.md)。跨主机能力将进入独立公开仓库，不把 SSH、安装器和模型网关堆入本插件。阶段 A 的正式 Remote Project service 只通过本插件现有官方 API 暴露 socket bridge，不复制 Session JSONL/SQLite。

本包的 `package.json` 和 `remote-manifest` 导出包含正式、可机读的 `dsh.remote` manifest：声明固定 plugin/version、`remote` placement、Remote Project protocol/API、DSH 兼容范围、Session Control、Schedule、runtime-auth 和 execution-policy capabilities，以及随插件版本绑定的 bundled Skill SHA-256。socket bridge 的 `remote-project.ping` 也返回同一 manifest，Remote Host 可据此按 Desired State allowlist 部署；manifest 不扩展本插件的单 Host 存储边界。

跨会话 relay 的持久 `user/message.source` 会记录版本化来源元数据：固定生产者 `dsh-session-control`、来源/目标 Session、operation、展示方 `DSH`，以及发送时的有界来源任务标题。标题只用于展示，不参与授权；来源身份和 operation 仍由 Host 已验证对象写入，界面不得从消息正文推断可信来源。这样冷会话重开、分页和页面刷新后仍能显示“由 DSH 从任务……发送”。

`session_send` / `session_batch_send` 默认是“派发即返回”：来源会话无需保持当前轮等待。send 或 batch 进入终态/需关注状态时，插件用稳定消息 ID 写入一份可去重的 `operation-terminal-report` / `operation-attention-report` 并调用来源会话的普通 follow-up；来源正在运行时排到后续独立轮，来源 idle 时自动唤醒。batch 只回报父 operation 的聚合结果，不逐个子项刷屏。通知状态与 operation 一起 A/B 持久化；重启先检查来源 Session/inbox 是否已有相同消息 ID，再决定落账或重投，不把响应丢失变成重复回报。升级前旧 operation 按 `manual` 迁移，不会集中回放历史结果。

## 安全模型

- **默认无控制者**：`controllerSessionIds` 为空且 `authorizeAllOrdinarySessions=false` 时，不向任何 Agent 注册工具。
- **工具按 Agent scope 注册**：受管部署可只向显式控制会话挂载；个人 DSH 可显式启用 `authorizeAllOrdinarySessions`，让所有普通用户会话获得工具。subagent 不会因该开关获得工具，中继轮即使来自已授权普通会话也会在执行时被拒绝。
- **执行时重复鉴权**：工具可见性只是界面边界；每次执行仍校验精确 controller id、普通会话、非 self、非 subagent；当前默认允许同一 DSH Host 内跨工作区控制，投递和运行态管理仍要求目标为 live。
- **权限预设决定授权方式**：Workspace Write 控制器的副作用继续走 `tools/pre-execute → ask`；只有当前原生预设确认为 `danger-full-access` 的控制器可自主执行。判定读取 DSH 会话事件折叠结果，不接受消息自报。
- **子会话审批不错误集中**：仅由 `danger-full-access` 控制器创建/恢复的受管会话，以及该控制器发起的 relay / Schedule 轮次，可把目标审批路由回来源控制器；Workspace Write 控制器不截获，人工审批卡保留在子会话 UI。
- **权限调整按方向授权**：Full access 控制器可自主升降子会话权限；Workspace Write 控制器调整到 `read-only` / `workspace-write` 时在来源审批，提升为 `danger-full-access` 时必须在目标子会话 UI 人工审批。
- **子代理可以只降权**：外部编码代理可在当前目标 Session 权限之下请求 `read-only` 或 `workspace-write`；Session Control 每次按目标 Session 实时验证，任何提权请求都会在启动前拒绝。
- **中继降权**：目标系统提示明确把 `<dsh-session-relay>` 视作不受信委派；正文 JSON 会转义 `<`，不能闭合包裹。中继触发的轮次不能调用任何会话控制工具。
- **单向编排**：目标默认没有控制工具；即使目标也是 controller，中继轮也会被 Host 拒绝，阻断 A→B→A 自动循环。

## 工具

| 工具 | 说明 |
| --- | --- |
| `session_status` | 列出同一 Host 内 live 会话，可选包含持久 cold 会话 |
| `session_events` | 默认只读显著事件元数据；Workspace Write 的正文读取需审批 |
| `session_send` | 幂等异步投递；默认终态/需关注时持久自动回报来源会话 |
| `session_batch_send` | 分发 1–8 项，创建 batch 父子图并只发送一份聚合回报 |
| `session_wait` | 仅供同轮依赖、显式等待或审批处理；不再是派发后的默认动作 |
| `session_wait_many` | 同时等待 1–20 个 operation，支持 revision cursor 和需关注状态 |
| `session_interrupt` | 按权限预设授权后中断当前轮，可等待真正 idle |
| `session_cancel` | 精确取消排队 operation；只中断属于该 operation 的活动轮 |
| `session_open` | 按权限预设授权后创建、恢复或 fork 普通会话 |
| `session_manage` | 按权限预设授权后重命名，或 suspend 本插件持有的会话 |
| `session_schedule_create` | 按权限预设授权后创建原生持久 after/at/every 定时任务 |
| `session_schedule_list` | 查看 live/cold 会话定时任务；正文默认按哈希隐藏 |
| `session_schedule_delete` | 按权限预设授权后删除目标会话定时任务 |
| `session_permission_get` | 读取 live/cold 子会话的原生权限预设、沙箱模式和审批策略 |
| `session_permission_set` | 持久升降子会话权限；Workspace Write 请求 Full access 时在子会话 UI 审批 |
| `session_approval_list` | 查看由当前 Full Access 控制器承接的子会话待审批项 |
| `session_approval_decide` | Full Access 控制器按指纹自主批准一次或拒绝；决定幂等持久化 |
| `session_workspace_list` | 列出 DSH 已注册工作区、目录状态与会话归属 |
| `session_workspace_add` | 按权限预设授权后创建目录并注册/复用 DSH Workspace |
| `session_project_open` | 按权限预设授权后完成目录、Workspace、会话创建与 attach |
| `session_operations` | 分页查看来源 controller 自己的持久 operation |

`session_status(include_cold=true)` 可以同时列出当前授权范围内的持久 cold 会话。`session_events` 支持 `before_seq` / `after_seq` 分页并可直接读取 cold 历史；正文与工具参数/结果在 Workspace Write 下需人工审批，在 `danger-full-access` 下由控制器自主读取。`session_open` 可覆盖 provider、model、reasoning effort 和初始权限，模型覆盖值会先经 DSH LLM Core 精确校验。

## 内置 Skill

插件会向 DSH 的原生 Skill Registry 自动注册 `dsh-session-control`，无需用户复制文件或配置额外 skill 路径。它把自然语言请求编排为发现、项目启动、权限选择、异步派发、自动回报、按需等待、定时、审批、恢复和收尾流程，同时继续以插件的实时鉴权与 operation 状态为最终事实源。

该 Skill 是插件自带内容，版本和摘要随 `dsh.remote.bundledSkills` manifest 固定；项目独立 Skill 不写入本插件的 Session/operation 状态，也不由本插件自行下载或执行安装脚本。

例如，控制会话可以直接接受：

- “在 `D:\Project\new-app` 创建项目并开始开发。”
- “让这个子会话长期自主运行，完成后恢复工作区写入。”
- “每 30 分钟检查一次，遇到阻塞就继续处理。”
- “查看所有工作区里的任务进度。”

项目自己的 `.dsh/skills/dsh-session-control/SKILL.md` 可以按 DSH 原生优先级覆盖这个内置版本，方便为单个项目增加更具体的操作约定。内置源文件位于 `skills/dsh-session-control/SKILL.md`，会随 npm/GitHub 安装包一起发布。

## 子会话权限管理

- `session_permission_get` 只读折叠目标的 `permission/preset`、`sandbox/mode` 和 `approval/policy`，读取 cold 会话时不会恢复它。
- `session_permission_set` 只接受 `read-only`、`workspace-write`、`danger-full-access`，并把来源、目标、旧值、新值、原因、授权位置和幂等键记录为持久 `permission` operation。
- Full access 控制器可自主升降 live/cold 子会话。Workspace Write 控制器调为 `read-only` 或 `workspace-write` 时走来源会话逐次审批；请求 `danger-full-access` 时不在主会话集中人工审批，而是向目标投递插件内部请求，在目标自己的开放 turn 内调用 DSH 原生 `approval.request()`。
- 内部权限请求在 `agent/pre-step` 中处理并从进入模型的消息列表移除。批准前会再次核对来源权限和目标旧权限；任何变化都会零执行。只有目标返回 `allowed-once` 后才调用原生 `permissionPresets.apply()`，随后 flush 并验证折叠值。
- cold 目标会临时 resume，结算后重新收敛为 cold。插件重启时只恢复尚未领取的内部请求；已经进入审批但未确认的请求标记失败且绝不重放。
- `session_open` 和 `session_project_open` 支持 `permission_preset`。Workspace Write 创建 Full access 子会话时，先以受限权限创建，再在新子会话 UI 请求提升；父 operation 返回 `permission_operation`，可用 `session_wait` 独立等待。
- 子会话切到 `danger-full-access` 后，其沙箱为完全访问且审批策略为 `never`，会自行运行而不再逐项请求主线程审批；需要逐项监督时应保留 `workspace-write`，由 Full access 主线程承接其请求。

## 主线程自主审批

- 控制器当前原生权限预设为 `danger-full-access` 时，插件允许控制工具自主执行，并把受管子会话直接轮次、relay 轮次及 Schedule 轮次产生的 `approval/request` 优先承接到来源控制器。
- 插件向来源控制器注入不含目标理由正文的 steering 通知；控制器先调用 `session_approval_list` 读取完整待审批项，再调用 `session_approval_decide` 决定 `allowed-once` 或 `rejected`。
- 决定绑定来源/目标会话、来源 operation、turn、approval id、call id、工具名、理由和 SHA-256 指纹；过期或指纹不匹配时零执行。决定使用幂等键，目标实际写入 `approval/decided` 后才报告 confirmed。
- 控制器切换为 Workspace Write、离线或等待超时时，尚未决定的请求调用原生 downstream answerer，审批卡留在子会话；不会转移到主会话要求人工点击。
- DSH 的 pending approval 是同进程开放 turn 内的 Promise，不能跨重启恢复。插件重启时取消未决集中审批，不会重放旧的 `allowed-once`；已经确认的决定 operation 仍可审计。

## 定时任务

- Bundle 会在控制插件之前加载官方 `@deepseek-ai/dsh-schedule`，定时事实写入目标会话自己的 `schedule/change` 事件流；本插件不维护第二套提醒协议。
- 控制器可以跨会话创建、查询和删除 `after_seconds`、显式 `at`、以及至少 5 分钟的固定间隔 `every_seconds`。
- 若目标为 cold，管理操作会临时 resume，完成原生持久化屏障后重新收敛为 cold。
- 由控制器审批创建的任务会被持久 operation 跟踪。目标到期时即使为 cold，协调器也会自动恢复；官方 Schedule 完成 dispatch 并让会话回到 idle 后，再收敛为 cold。
- 创建或删除返回 `persistence_uncertain` 时不会冒险重试，而是保留幂等键并进入 `needs_attention`，要求先 list 对账。

## 工作区与项目启动

- `session_workspace_add` 只接受绝对路径；可递归创建不存在的目录，然后调用 `ctx.workspaceRegistry.create()`。规范路径已存在时幂等复用。
- `session_project_open` 复用 DSH Host 的正式顺序：确保目录 → 注册 Workspace → Core Agent Factory 创建会话 → `Workspace.attachSession()`。
- Agent 创建成功但 Workspace attach 失败时返回 `partial`，不会删除目录、Workspace 或已经创建的会话来掩盖部分成功。

## Operation 与恢复

- 使用标准 UUID、正文 SHA-256 和来源绑定幂等键。
- 用 `agent/inbox/claimed` / `agent/inbox/discarded` 的精确消息身份和 `session/event` 的 turn 坐标结算，不猜测任意 splice。
- 状态写入 `stateDir` 下 A/B 双槽 v2 快照；每代 `fsync`，启动时选择最高有效 generation。v1 自动迁移，且两槽均损坏时拒绝启动。
- DSH 重启后从 live Session 或 `sessionPersistence.inspect()` 对未完成 send / permission operation 进行对账；不会自动重发无法确认的消息或权限批准。被重启打断且无法证明终态的 lifecycle operation 会保留幂等键并转为 `delivery-unknown` / `needs_attention`，不会冒险重复创建或销毁。
- 每次 durable mutation 都有单调 revision；多操作等待和审计分页使用 opaque cursor，已报告状态不会重复唤醒。
- batch 父 operation 根据子 operation 自动汇总为 running、needs-attention、completed、partial、aborted 或 failed；只有父 operation 触发自动回报。
- 每来源、每目标、每分钟和总 operation 数都有上限；历史手动 operation 或已确认回报的终态根 operation 可在容量紧张时按时间淘汰，尚未交付的自动回报不会被提前清除。

## 生命周期边界

- `create`、`resume`、`fork` 使用 DSH Core 的事务化 Agent Factory；preset 在发布前完成组合，失败不会留下半配置 live 会话。
- fork 只截取完整 `turn/end` 边界，并保留 `parentSession` / `seedLength` 血缘。
- 新开会话仍使用相同工作目录，返回 `workspace_isolated=false`；当前 DSH Core 没有供该插件调用的 Git worktree 创建能力。
- `suspend` 只接受本插件当前进程持有 lifecycle handle 的会话，不能销毁其他所有者的 Agent。
- 不提供跨主机 handoff 或普通会话与 subagent 的统一生命周期；这些仍需要独立 Core 服务。

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
        authorizeAllOrdinarySessions: false
        stateDir: 'D:\\path\\to\\.dsh-home\\session-control'
        sameWorkspaceOnly: false
        maxPendingPerTarget: 3
        maxPendingPerSource: 10
        rateLimitPerMinute: 5
        maxOperations: 500
        approvalDelegationTimeoutMs: 900000
        remoteProjectSocket: '/run/user/1000/dsh-session-control.sock'
        remoteProjectHostId: 'remote-host-01'
        remoteProjectSourceAllowlist:
          - sourceHostId: 'local-host-01'
            sourceSessionId: 'controller-session-01'
            controllerSessionId: 'remote-host-controller-01'
```

配置 `remoteProjectSocket` 后，插件启动一个权限为 `0600` 的 Unix socket bridge；它接受 `remote-project.ping`、`remote-project.open`、`remote-project.schedule-create`、`remote-project.schedule-delete`、`remote-project.runtime-auth-begin`、`remote-project.runtime-auth-confirm` 和 `remote-project.execution-policy-verify`，串行调用官方 `openProject` / `createSchedule` / `deleteSchedule` API 与当前 Host 的 Session/权限状态。独立 Schedule 创建和删除都必须绑定原来源 controller、真实 target Session 和独立幂等键，不能通过重新打开项目或直接编辑 Session 日志冒充。`remoteProjectSourceAllowlist` 必须显式列出 `sourceHostId`、`sourceSessionId` 以及远端实际执行 API 的 `controllerSessionId`；空 allowlist fail closed，来源身份不会被当成远端 Agent 查询。运行时首次认证只绑定来源控制端、Host 和精确 runtime，可在新项目 Session 创建前完成；执行策略核验必须在 Session 创建后按真实 target Session 实时查询。socket 路径或 Host ID 缺失、占用路径不是 socket、或官方服务不可用时，bridge 启动失败；不提供静默 fake fallback。

当前默认 `sameWorkspaceOnly=false`，因此控制器可管理同一 DSH Host 内不同 Workspace 的普通会话；跨主机和子代理仍不在这条链路中。对 cold 普通会话开放列举、历史、定时管理和经审批的 Core resume；投递、中断与一般运行态管理仍要求目标为 live。子代理继续使用 DSH 原生 `send_message` / `interrupt_agent`。

个人单用户 DSH 若希望“在任意普通会话中直接要求添加目录、创建项目或控制其他普通会话”，应设置 `authorizeAllOrdinarySessions: true`。该模式按当前会话原生权限预设继续执行 Workspace Write 审批或 Full Access 自主授权，不把权限授予 subagent，也不允许 relay 轮继续发起会话控制。

## 验证

```powershell
# 本仓库 engines 要求 Node.js >=24
npm test
npm run check
npm pack --dry-run
```

Windows 上若系统 Node 低于 24，测试 runner 会明确拒绝并提示版本；Linux 目标上的 Unix socket bridge 集成测试在 Linux 环境执行，Windows 本地仅执行正式 port 的跨平台契约测试。

测试覆盖：作用域可见性、跨工作区开关、中继轮阻断、Full Access 自主授权、Workspace Write 子会话本地审批、权限升降/方向授权/目标审批/冷会话/创建初始权限/幂等防重放、集中审批指纹/确认、Schedule 审批路由、并发幂等、批次父子汇总、cursor 多等待、精确取消、cold 历史分页、原生定时创建/隐藏/删除、项目目录与 Workspace/Session attach、Core 创建/fork/suspend、v1→v2 迁移、A/B 状态恢复和损坏双槽 fail-closed。
