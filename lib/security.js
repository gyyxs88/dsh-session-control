import { createHash } from 'node:crypto'
import path from 'node:path'

export const PLUGIN_ID = 'dsh-session-control'
export const CONTROL_TOOL_NAMES = Object.freeze([
  'session_status',
  'session_events',
  'session_send',
  'session_wait',
  'session_interrupt',
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
    deliveryAuthorization: 'approved-once-by-human-at-source',
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
  if (toolName === 'session_interrupt') {
    return `跨会话中断 → ${targetId}；原因：${previewText(args?.reason ?? '未提供')}`
  }
  if (toolName === 'session_events' && args?.include_content === true) {
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
  if (event.type === 'tool/call') return {
    ...base,
    turn: data.turn,
    step: data.step,
    name: data.name,
  }
  if (event.type === 'approval/asked') return {
    ...base,
    tool_name: data.toolName,
  }
  if (event.type === 'approval/decided') return {
    ...base,
    outcome: data.outcome,
  }
  return base
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
])
