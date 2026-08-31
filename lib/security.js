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
  'session_permission_get',
  'session_permission_set',
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

/**
 * Admit one live ordinary Session as a controller when the deployment opted
 * into host-wide ordinary-session control. Explicit ids keep their historical
 * behavior; the broad mode never admits a DSH subagent and remembers admitted
 * ids so durable operations can continue after the source becomes cold.
 */
export function admitControllerAgent(
  agents,
  agent,
  controllerSessionIds,
  authorizeAllOrdinarySessions = false,
) {
  if (isAuthorizedController(agent, controllerSessionIds)) return true
  if (!authorizeAllOrdinarySessions
    || agent?.id === undefined
    || !(controllerSessionIds instanceof Set)
    || isSubagentOwned(agents, agent)) return false
  controllerSessionIds.add(agent.id)
  return true
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

/**
 * Resolve the latest durable task title for provenance display.
 * Titles are presentation data, not authority.
 */
export function sessionDisplayTitle(events, maxChars = 120) {
  if (!Array.isArray(events)) return undefined
  const title = events.findLast((event) => (
    event?.type === 'session/title'
    && typeof event.data?.title === 'string'
  ))?.data?.title
  if (title === undefined) return undefined
  const normalized = title
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized.length === 0 || !Number.isSafeInteger(maxChars) || maxChars < 2) return undefined
  return normalized.length <= maxChars
    ? normalized
    : `${normalized.slice(0, maxChars - 1)}…`
}

/** Trusted, durable provenance attached to one cross-session relay message. */
export function relayMessageSource(operation, source, target) {
  const senderSessionTitle = sessionDisplayTitle(source?.session?.events)
  return {
    kind: 'plugin',
    plugin: PLUGIN_ID,
    form: 'relay',
    provenanceVersion: 1,
    senderDisplayName: 'DSH',
    senderSessionId: source.id,
    ...(senderSessionTitle === undefined ? {} : { senderSessionTitle }),
    targetSessionId: target.id,
    operationId: operation.id,
  }
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
    return `跨会话投递 → ${targetId}；正文预览：${previewText(content)}；SHA-256：${contentHash(content)}；终态回报：${String(args?.completion_delivery ?? 'followup')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_batch_send') {
    const items = Array.isArray(args?.items) ? args.items.slice(0, 10) : []
    const rows = items.map((item) => {
      const content = typeof item?.content === 'string' ? item.content : ''
      return `${String(item?.target_id ?? '(missing)')} [${contentHash(content)}] ${previewText(content, 80)}`
    })
    return `批量跨会话投递 ${items.length} 项；终态回报：${String(args?.completion_delivery ?? 'followup')}；批次幂等键：${String(args?.idempotency_key ?? '(missing)')}；${rows.join('；')}`
  }
  if (toolName === 'session_interrupt') {
    return `跨会话中断 → ${targetId}；原因：${previewText(args?.reason ?? '未提供')}`
  }
  if (toolName === 'session_cancel') {
    const ids = Array.isArray(args?.operation_ids) ? args.operation_ids : []
    return `取消跨会话操作 ${ids.join(', ') || '(missing)'}；原因：${previewText(args?.reason ?? '未提供')}`
  }
  if (toolName === 'session_open') {
    return `会话生命周期操作 → ${String(args?.mode ?? '(missing)')}；源会话：${String(args?.source_session_id ?? args?.resume_session_id ?? '当前控制会话')}；provider/model/reasoning：${String(args?.provider ?? '(inherit)')}/${String(args?.model ?? '(inherit)')}/${String(args?.reasoning_effort ?? '(inherit)')}；初始权限：${String(args?.permission_preset ?? '(preserve/default)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
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
  if (toolName === 'session_permission_set') {
    return `调整子会话权限 → ${targetId}；目标权限：${String(args?.permission_preset ?? '(missing)')}；原因：${previewText(args?.reason ?? '未提供')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_workspace_add') {
    return `添加 DSH 工作区 → ${String(args?.path ?? '(missing)')}；${args?.create_directory === false ? '目录必须已存在' : '目录不存在时递归创建'}；标题：${previewText(args?.title ?? '(path basename)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_project_open') {
    return `准备项目并创建会话 → ${String(args?.path ?? '(missing)')}；${args?.create_directory === false ? '目录必须已存在' : '目录不存在时递归创建'}；provider/model/reasoning：${String(args?.provider ?? '(inherit)')}/${String(args?.model ?? '(inherit)')}/${String(args?.reasoning_effort ?? '(inherit)')}；初始权限：${String(args?.permission_preset ?? '(default)')}；幂等键：${String(args?.idempotency_key ?? '(missing)')}`
  }
  if (toolName === 'session_events'
    && (args?.include_content === true || args?.include_tool_results === true)) {
    return `读取会话正文片段 → ${targetId}；最多 ${Number(args?.limit) || 20} 条显著事件`
  }
  return undefined
}

function jsonInteger(value) {
  return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : null
}

function jsonString(value) {
  return typeof value === 'string' ? value : null
}

function eventCallId(data) {
  return jsonString(data?.callId) ?? jsonString(data?.message?.source?.callId)
}

function contentText(content, maxChars) {
  if (!Array.isArray(content) || !Number.isSafeInteger(maxChars) || maxChars < 1) return ''
  const pending = [...content]
  const parts = []
  let length = 0
  while (pending.length > 0 && length < maxChars) {
    const block = pending.shift()
    if (block?.type === 'text' && typeof block.text === 'string') {
      const separatorLength = parts.length > 0 ? 1 : 0
      const remaining = maxChars - length - separatorLength
      if (remaining < 1) break
      const text = block.text.slice(0, remaining)
      if (text.length > 0) {
        parts.push(text)
        length += separatorLength + text.length
      }
      continue
    }
    if (Array.isArray(block?.content)) pending.unshift(...block.content)
  }
  return parts.join(' ')
}

function summaryVisibility(value) {
  if (typeof value === 'boolean') {
    return { includeContent: value, includeToolResults: value }
  }
  return {
    includeContent: value?.includeContent === true,
    includeToolResults: value?.includeToolResults === true,
  }
}

export function summarizeEvent(event, visibility = false) {
  const { includeContent, includeToolResults } = summaryVisibility(visibility)
  const data = event.data ?? {}
  const base = {
    seq: jsonInteger(event.seq),
    type: jsonString(event.type) ?? 'unknown',
  }
  if (event.type === 'turn/start') return { ...base, turn: jsonInteger(data.turn) }
  if (event.type === 'turn/end') return {
    ...base,
    turn: jsonInteger(data.turn),
    reason: jsonString(data.reason?.kind),
  }
  if (event.type === 'step/start' || event.type === 'step/end') return {
    ...base,
    turn: jsonInteger(data.turn),
    step: jsonInteger(data.step),
  }
  if (event.type === 'user/message') {
    const row = {
      ...base,
      message_id: jsonString(data.id),
      source_kind: jsonString(data.source?.kind),
    }
    if (includeContent) {
      row.text = contentText(data.content, 500)
    }
    return row
  }
  if (event.type === 'assistant/message') {
    const row = {
      ...base,
      turn: jsonInteger(data.turn),
      step: jsonInteger(data.step),
    }
    if (includeContent) {
      row.text = contentText(data.message?.content, 800)
    }
    return row
  }
  if (event.type === 'tool/call') {
    const row = {
      ...base,
      turn: jsonInteger(data.turn),
      step: jsonInteger(data.step),
      call_id: eventCallId(data),
      name: jsonString(data.name),
    }
    if (includeToolResults) row.arguments = String(data.arguments ?? '').slice(0, 1000)
    return row
  }
  if (event.type === 'tool/result') {
    const row = {
      ...base,
      turn: jsonInteger(data.turn),
      step: jsonInteger(data.step),
      call_id: eventCallId(data),
      error: jsonString(data.error?.code) ?? jsonString(data.message?.error?.code),
    }
    if (includeToolResults) {
      row.text = contentText(data.message?.content, 1500)
    }
    return row
  }
  if (event.type === 'approval/asked') return {
    ...base,
    tool_name: jsonString(data.toolName),
  }
  if (event.type === 'approval/decided') return {
    ...base,
    outcome: jsonString(data.outcome),
  }
  if (event.type === 'schedule/change') {
    const change = data
    const row = {
      ...base,
      operation: jsonString(change.operation),
      schedule_id: jsonString(change.schedule?.id) ?? jsonString(change.id),
      kind: jsonString(change.schedule?.kind),
      scheduled_at: jsonString(change.schedule?.scheduledAt),
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
    const callId = eventCallId(data)
    if (event.type === 'tool/call' && callId !== null) calls.set(callId, data)
    if (event.type === 'tool/result' && callId !== null) calls.delete(callId)
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
        id: jsonString(row.id),
        tool_name: jsonString(row.toolName),
        reason: jsonString(row.reason),
      })),
    }
  }
  const questions = [...calls.values()].filter((call) => call.name === 'ask_user_question')
  if (questions.length > 0) {
    return {
      needs_attention: true,
      kind: 'user-input',
      call_ids: questions.map((call) => eventCallId(call)).filter((callId) => callId !== null),
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
