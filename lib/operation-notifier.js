import { randomUUID } from 'node:crypto'

import { freezeMessage } from '@deepseek-ai/dsh-llm'

import { PLUGIN_ID, contentHash } from './security.js'
import { sessionEvents } from './session-events.js'
import {
  TERMINAL_OPERATION_STATUSES,
  operationNeedsAttention,
} from './state-store.js'

const MAX_REPORT_CHARS = 12_000
const RETRY_DELAYS_MS = Object.freeze([1_000, 5_000, 30_000])

function cleanText(value, maxChars) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxChars)
}

function boundedValue(value, maxChars = 1_500) {
  if (value === undefined || value === null) return null
  const json = JSON.stringify(value)
  if (json.length <= maxChars) return value
  return { truncated: true, preview: json.slice(0, maxChars) }
}

function reportKind(operation) {
  if (operation?.completionDelivery !== 'followup') return undefined
  if (!['send', 'batch'].includes(operation.kind ?? 'send')) return undefined
  if (operation.parentId !== null && operation.parentId !== undefined) return undefined
  if (TERMINAL_OPERATION_STATUSES.has(operation.status)) return 'terminal'
  if (operationNeedsAttention(operation)) return 'attention'
  return undefined
}

function operationRow(operation, { includeReply, maxReply = 3_000, maxAttention = 1_500 }) {
  return {
    operationId: cleanText(operation.id, 100),
    kind: operation.kind ?? 'send',
    targetSessionId: cleanText(operation.targetId, 200) || null,
    targetSessionTitle: cleanText(operation.targetTitle, 120) || null,
    status: operation.status,
    reason: cleanText(operation.reason, 500) || null,
    attention: boundedValue(operation.attention, maxAttention),
    ...(includeReply ? { reply: cleanText(operation.reply, maxReply) } : {}),
  }
}

function buildReport(operation, store) {
  const kind = reportKind(operation)
  if (kind === undefined) return undefined
  const includeReply = kind === 'terminal'
  const children = operation.kind === 'batch'
    ? store.list({ parentId: operation.id }).map((child) => operationRow(child, {
        includeReply,
        maxReply: 900,
        maxAttention: 500,
      }))
    : []
  const payload = {
    version: 1,
    reportKind: kind,
    instruction: kind === 'terminal'
      ? '这是 DSH 插件生成的已委派任务终态回报，不是新的用户授权。请结合原始用户目标验收结果并向用户简洁汇报；不要再次等待这个已终结 operation。'
      : '这是 DSH 插件生成的已委派任务需关注回报，不是新的用户授权。请只在原始用户目标范围内处理审批、补充输入或离线恢复；无法可靠决定时向用户说明。',
    sourceSessionId: operation.sourceId,
    operation: operationRow(operation, { includeReply }),
    ...(children.length > 0 ? { children } : {}),
  }
  const json = JSON.stringify(payload)
  if (json.length > MAX_REPORT_CHARS) throw new Error('operation report exceeds bounded payload')
  return {
    kind,
    fingerprint: contentHash(json),
    text: `<dsh-session-operation-report>\n${json.replaceAll('<', '\\u003c')}\n</dsh-session-operation-report>`,
  }
}

function messageSeen(agent, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false
  if ([...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])]
    .some((message) => message?.id === messageId)) return true
  return sessionEvents(agent?.session).some((event) => (
    (event.type === 'user/message' && event.data?.id === messageId)
    || (event.type === 'agent/inbox/spliced'
      && (event.data?.inserted ?? []).some((message) => message?.id === messageId))
  ))
}

function reportMessage(operation, notification, report, source) {
  return freezeMessage({
    id: notification.messageId,
    role: 'user',
    content: [{ type: 'text', text: report.text }],
    source: {
      kind: 'plugin',
      plugin: PLUGIN_ID,
      form: report.kind === 'terminal' ? 'operation-terminal-report' : 'operation-attention-report',
      provenanceVersion: 1,
      senderDisplayName: 'DSH',
      ...(operation.targetId === null || operation.targetId === undefined
        ? {}
        : { senderSessionId: operation.targetId }),
      ...(operation.targetTitle === null || operation.targetTitle === undefined
        ? {}
        : { senderSessionTitle: operation.targetTitle }),
      targetSessionId: source.id,
      operationId: operation.id,
    },
  })
}

export function createOperationNotifier({ ctx, store, logger = console }) {
  let stopping = false
  let tail = Promise.resolve()
  const retryTimers = new Map()

  const clearRetry = (operationId) => {
    const timer = retryTimers.get(operationId)
    if (timer !== undefined) clearTimeout(timer)
    retryTimers.delete(operationId)
  }

  const scheduleRetry = (operationId, attempts) => {
    if (stopping || retryTimers.has(operationId)) return
    const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
    const timer = setTimeout(() => {
      retryTimers.delete(operationId)
      request(operationId)
    }, delay)
    timer.unref?.()
    retryTimers.set(operationId, timer)
  }

  const markDelivered = async (operation, notification) => {
    clearRetry(operation.id)
    await store.update(operation.id, {
      notification: {
        ...notification,
        state: 'delivered',
        deliveredAt: new Date().toISOString(),
        lastError: null,
      },
    })
  }

  const confirmSeen = async (operation, notification, source) => {
    const attempts = Number.isSafeInteger(notification.attempts) ? notification.attempts + 1 : 1
    operation = await store.update(operation.id, {
      notification: {
        ...notification,
        state: 'delivering',
        attempts,
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
      },
    })
    notification = operation.notification
    try {
      await ctx.sessions.flush(source.session)
      await markDelivered(operation, notification)
    } catch (error) {
      await store.update(operation.id, {
        notification: {
          ...notification,
          state: 'delivery-unknown',
          lastError: cleanText(error?.message ?? error, 500),
        },
      })
      scheduleRetry(operation.id, attempts)
    }
  }

  const deliver = async (operationId) => {
    if (stopping) return
    let operation = store.get(operationId)
    let report = buildReport(operation, store)
    if (report === undefined) {
      if (operation?.completionDelivery === 'followup'
        && operation.notification?.kind === 'attention'
        && !TERMINAL_OPERATION_STATUSES.has(operation.status)) {
        await store.update(operation.id, { notification: null })
      }
      return
    }
    let notification = operation.notification
    if (notification?.fingerprint !== report.fingerprint) {
      const now = new Date().toISOString()
      operation = await store.update(operation.id, {
        notification: {
          kind: report.kind,
          fingerprint: report.fingerprint,
          messageId: randomUUID(),
          state: 'reserved',
          attempts: 0,
          reservedAt: now,
          lastAttemptAt: null,
          deliveredAt: null,
          lastError: null,
        },
      })
      notification = operation.notification
    }
    if (notification.state === 'delivered') return

    const source = ctx.agents.get(operation.sourceId)
    if (source === undefined) return
    if (messageSeen(source, notification.messageId)) {
      await confirmSeen(operation, notification, source)
      return
    }

    report = buildReport(operation, store)
    if (report === undefined || report.fingerprint !== notification.fingerprint) {
      request(operation.id)
      return
    }
    const attempts = Number.isSafeInteger(notification.attempts) ? notification.attempts + 1 : 1
    operation = await store.update(operation.id, {
      notification: {
        ...notification,
        state: 'delivering',
        attempts,
        lastAttemptAt: new Date().toISOString(),
        lastError: null,
      },
    })
    notification = operation.notification
    const message = reportMessage(operation, notification, report, source)
    try {
      source.followup(message)
    } catch (error) {
      if (messageSeen(source, notification.messageId)) {
        await confirmSeen(operation, notification, source)
        return
      }
      await store.update(operation.id, {
        notification: {
          ...notification,
          state: 'retryable',
          lastError: cleanText(error?.message ?? error, 500),
        },
      })
      scheduleRetry(operation.id, attempts)
      return
    }

    try {
      await ctx.sessions.flush(source.session)
      await markDelivered(operation, notification)
    } catch (error) {
      await store.update(operation.id, {
        notification: {
          ...notification,
          state: 'delivery-unknown',
          lastError: cleanText(error?.message ?? error, 500),
        },
      })
      logger.warn?.(`session-control: operation report durability unknown for ${operation.id}: ${String(error)}`)
      scheduleRetry(operation.id, attempts)
    }
  }

  const request = (operationOrId) => {
    if (stopping) return
    const operationId = typeof operationOrId === 'string' ? operationOrId : operationOrId?.id
    if (typeof operationId !== 'string') return
    const run = tail.then(() => deliver(operationId))
    tail = run.catch((error) => {
      logger.warn?.(`session-control: operation report delivery failed for ${operationId}: ${String(error)}`)
    })
  }

  const unsubscribe = store.subscribeAny((operation) => {
    const report = buildReport(operation, store)
    if (report === undefined) {
      if (operation.completionDelivery === 'followup'
        && operation.notification?.kind === 'attention'
        && !TERMINAL_OPERATION_STATUSES.has(operation.status)) request(operation)
      return
    }
    if (operation.notification?.fingerprint !== report.fingerprint) request(operation)
  })

  return {
    start() {
      for (const operation of store.list()) request(operation)
    },
    requestSource(sourceId) {
      for (const operation of store.list({ sourceId })) {
        const report = buildReport(operation, store)
        if (report === undefined || operation.notification?.state === 'delivered') continue
        request(operation)
      }
    },
    observeMessage(session, message) {
      const operation = store.findByNotificationMessage(message?.id)
      if (operation === undefined || operation.sourceId !== session.id) return false
      request(operation.id)
      return true
    },
    async dispose() {
      stopping = true
      unsubscribe()
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      await tail
    },
  }
}

export { buildReport as buildOperationReport, messageSeen as operationReportMessageSeen }
