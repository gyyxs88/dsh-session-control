import { createHash } from 'node:crypto'
import path from 'node:path'

export const PLUGIN_ID = 'dsh-session-control'
export const CONTROL_TOOL_NAMES = Object.freeze([
  'session_status',
  'session_events',
  'session_send',
  'session_batch_send',
  'session_wait',
  'session_wait_many',
  'session_interrupt',
  'session_cancel',
  'session_open',
  'session_manage',
  'session_schedule_create',
  'session_schedule_list',
  'session_schedule_delete',
  'session_approval_list',
  'session_approval_decide',
  'session_workspace_list',
  'session_workspace_add',
  'session_project_open',
  'session_operations',
])

export function canonicalWorkspace(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function sameWorkspace(left, right) {
  const a = canonicalWorkspace(left)
  const b = canonicalWorkspace(right)
  return a !== undefined && b !== undefined && a === b
}

export function isAuthorizedController(agent, controllerSessionIds) {
  return agent !== undefined
    && controllerSessionIds instanceof Set
    && controllerSessionIds.has(agent.id)
}

export function isSubagentOwned(agents, agent) {
  if (agent?.session?.header?.origin === 'subagent') return true
  const parentId = agent?.session?.header?.parentSession
  if (parentId === undefined) return false
  const parent = agents.get(parentId)
  return parent !== undefined && agents.isOwnedBy(agent.id, parent)
}

export function contentHash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function previewText(content, maxChars = 240) {
  const normalized = String(content).replace(/\s+/gu, ' ').trim()
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`
}

function escapeRelayJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export function relayEnvelope(operation, content) {
  const body = {
    version: 1,
    operationId: operation.id,
    sourceSessionId: operation.sourceId,
    targetSessionId: operation.targetId,
    contentSha256: operation.contentHash,
    deliveryAuthorization: operation.deliveryAuthorization
      ?? 'approved-once-by-human-at-source',
    content,
  }
  return `<dsh-session-relay>\n${escapeRelayJson(body)}\n</dsh-session-relay>`
}

export function isRelayMessage(message) {
  return message?.source?.kind === 'plugin'
    && message.source.plugin === PLUGIN_ID
    && message.source.form === 'relay'
}

export function currentTurnIsRelay(agent) {
  const events = agent?.session?.events
  if (!Array.isArray(events) || events.length === 0) return false
  let start = -1
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'turn/end') return false
    if (event.type === 'turn/start') {
      start = index
      break
    }
  }
  if (start < 0) return false
  return events.slice(start + 1).some((event) => (
    event.type === 'user/message'
    && isRelayMessage(event.data)
  ))
}

export function approvalReason(toolName, args) {
  const targetId = typeof args?.target_id === 'string' ? args.target_id : '(missing)'
  if (toolName === 'session_send') {
    const content = typeof args?.content === 'string' ? args.content : ''
    return `跨会话投递 → ${targetId}；正文预览：${previewText(content)}；SHA-256：${contentHash(content)}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_batch_send') {
    const items = Array.isArray(args?.items) ? args.items.slice(0, 10) : []
    const rows = items.map((item) => {
      const content = typeof item?.content === 'string' ? item.content : ''
      return `${String(item?.target_id ?? '(missing)')} [${contentHash(content)}] ${previewText(content, 80)}`
    })
    return `批量跨会话投递 ${items.length} 项；批次幂等键：${String(args?.idempotency_key ?? '(missing)')}；${rows.join('；')}`
  }
  if (toolName === 'session_interrupt') {
    return `跨会话中断 → ${targetId}；原因：${previewText(args?.reason ?? '未提供')}`
  }
  if (toolName === 'session_cancel') {
    const ids = Array.isArray(args?.operation_ids) ? args.operation_ids : []
    return `取消跨会话操作 ${ids.join(', ') || '(missing)'}；原因：${previewText(args?.reason ?? '未提供')}`
  }
  if (toolName === 'session_open') {
    return `会话生命周期操作 → ${String(args?.mode ?? '(missing)')}；源会话：${String(args?.source_session_id ?? args?.resume_session_id ?? '当前控制会话')}；provider/model/reasoning：${String(args?.provider ?? '(inherit)')}/${String(args?.model ?? '(inherit)')}/${String(args?.reasoning_effort ?? '(inherit)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_manage') {
    return `会话管理 → ${String(args?.action ?? '(missing)')} ${targetId}；${args?.action === 'rename' ? `新标题：${previewText(args?.title ?? '')}` : '将 live 会话安全收敛为 cold'}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_schedule_create') {
    const selector = args?.after_seconds !== undefined
      ? `after=${String(args.after_seconds)}s`
      : args?.at !== undefined
        ? `at=${previewText(JSON.stringify(args.at), 120)}`
        : `every=${String(args?.every_seconds ?? '(missing)')}s`
    return `创建跨会话定时任务 → ${targetId}；${selector}；提醒预览：${previewText(args?.prompt ?? '')}；SHA-256：${contentHash(String(args?.prompt ?? ''))}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_schedule_delete') {
    return `删除跨会话定时任务 → ${targetId}/${String(args?.schedule_id ?? '(missing)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_schedule_list' && args?.include_prompt === true) {
    return `读取跨会话定时任务正文 → ${targetId}`
  }
  if (toolName === 'session_workspace_add') {
    return `添加 DSH 工作区 → ${String(args?.path ?? '(missing)')}；${args?.create_directory === false ? '目录必须已存在' : '目录不存在时递归创建'}；标题：${previewText(args?.title ?? '(path basename)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_project_open') {
    return `准备项目并创建会话 → ${String(args?.path ?? '(missing)')}；${args?.create_directory === false ? '目录必须已存在' : '目录不存在时递归创建'}；provider/model/reasoning：${String(args?.provider ?? '(inherit)')}/${String(args?.model ?? '(inherit)')}/${String(args?.reasoning_effort ?? '(inherit)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_events'
    && (args?.include_content === true || args?.include_tool_results === true)) {
    return `读取会话正文片段 → ${targetId}；最多 ${Number(args?.limit) || 20} 条显著事件`
  }
  return undefined
}

export function summarizeEvent(event, includeContent = false) {
  const data = event.data ?? {}
  const base = { seq: event.seq, type: event.type }
  if (event.type === 'turn/start') return { ...base, turn: data.turn }
  if (event.type === 'turn/end') return {
    ...base,
    turn: data.turn,
    reason: data.reason?.kind ?? null,
  }
  if (event.type === 'step/start' || event.type === 'step/end') return {
    ...base,
    turn: data.turn,
    step: data.step,
  }
  if (event.type === 'user/message') {
    const row = {
      ...base,
      message_id: data.id,
      source_kind: data.source?.kind ?? null,
    }
    if (includeContent) {
      row.text = (data.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .slice(0, 500)
    }
    return row
  }
  if (event.type === 'assistant/message') {
    const row = { ...base, turn: data.turn, step: data.step }
    if (includeContent) {
      row.text = (data.message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .slice(0, 800)
    }
    return row
  }
  if (event.type === 'tool/call') {
    const row = {
      ...base,
      turn: data.turn,
      step: data.step,
      call_id: data.callId,
      name: data.name,
    }
    if (includeContent) row.arguments = String(data.arguments ?? '').slice(0, 1000)
    return row
  }
  if (event.type === 'tool/result') {
    const row = {
      ...base,
      turn: data.turn,
      step: data.step,
      call_id: data.callId,
      error: data.error?.code ?? null,
    }
    if (includeContent) {
      row.text = (data.message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .slice(0, 1500)
    }
    return row
  }
  if (event.type === 'approval/asked') return {
    ...base,
    tool_name: data.toolName,
  }
  if (event.type === 'approval/decided') return {
    ...base,
    outcome: data.outcome,
  }
  if (event.type === 'schedule/change') {
    const change = data
    const row = {
      ...base,
      operation: change.operation ?? null,
      schedule_id: change.schedule?.id ?? change.id ?? null,
      kind: change.schedule?.kind ?? null,
      scheduled_at: change.schedule?.scheduledAt ?? null,
    }
    if (includeContent && typeof change.schedule?.prompt === 'string') {
      row.prompt = change.schedule.prompt.slice(0, 1000)
    }
    return row
  }
  return base
}

export function sessionAttention(events) {
  const approvals = new Map()
  const calls = new Map()
  for (const event of events ?? []) {
    const data = event.data ?? {}
    if (event.type === 'approval/asked') approvals.set(data.id, data)
    if (event.type === 'approval/decided') approvals.delete(data.id)
    if (event.type === 'tool/call') calls.set(data.callId, data)
    if (event.type === 'tool/result') calls.delete(data.callId)
    if (event.type === 'turn/end') {
      for (const [callId, call] of calls) {
        if (call.turn === data.turn) calls.delete(callId)
      }
    }
  }
  if (approvals.size > 0) {
    return {
      needs_attention: true,
      kind: 'approval',
      approvals: [...approvals.values()].map((row) => ({
        id: row.id,
        tool_name: row.toolName,
        reason: row.reason ?? null,
      })),
    }
  }
  const questions = [...calls.values()].filter((call) => call.name === 'ask_user_question')
  if (questions.length > 0) {
    return {
      needs_attention: true,
      kind: 'user-input',
      call_ids: questions.map((call) => call.callId),
    }
  }
  return { needs_attention: false, kind: null }
}

export const SIGNIFICANT_EVENT_TYPES = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'schedule/change',
])
