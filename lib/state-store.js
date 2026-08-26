import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

export const TERMINAL_OPERATION_STATUSES = new Set([
  'completed',
  'partial',
  'aborted',
  'discarded',
  'failed',
])

export const ATTENTION_OPERATION_STATUSES = new Set([
  'awaiting-approval',
  'awaiting-input',
  'needs-attention',
  'target-offline',
  'delivery-unknown',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateSnapshot(value) {
  if (!isPlainObject(value) || ![1, 2].includes(value.version)) return undefined
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return undefined
  if (!Array.isArray(value.operations)) return undefined
  if (!value.operations.every((row) => (
    isPlainObject(row)
    && typeof row.id === 'string'
    && typeof row.sourceId === 'string'
    && (typeof row.targetId === 'string' || row.targetId === null)
    && typeof row.idempotencyKey === 'string'
    && typeof row.contentHash === 'string'
    && typeof row.status === 'string'
    && typeof row.createdAt === 'string'
    && typeof row.updatedAt === 'string'
  ))) return undefined
  if (value.version === 2 && (!Number.isSafeInteger(value.cursor) || value.cursor < 0)) return undefined
  if (value.version === 2 && !value.operations.every((row) => (
    Number.isSafeInteger(row.revision) && row.revision > 0 && row.revision <= value.cursor
  ))) return undefined
  return value
}

async function readSnapshot(file) {
  try {
    return {
      exists: true,
      value: validateSnapshot(JSON.parse(await readFile(file, 'utf8'))),
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, value: undefined }
    return { exists: true, value: undefined }
  }
}

function normalizeOperation(row, revision) {
  return {
    kind: row.kind ?? 'send',
    parentId: row.parentId ?? null,
    childIds: Array.isArray(row.childIds) ? [...row.childIds] : [],
    attention: row.attention ?? null,
    completionDelivery: row.completionDelivery ?? 'manual',
    notification: row.notification ?? null,
    revision: Number.isSafeInteger(row.revision) && row.revision > 0 ? row.revision : revision,
    ...row,
  }
}

function operationCanBePruned(operation) {
  return TERMINAL_OPERATION_STATUSES.has(operation.status)
    && (operation.completionDelivery !== 'followup' || operation.notification?.state === 'delivered')
}

export function operationNeedsAttention(operation) {
  return operation !== undefined
    && !TERMINAL_OPERATION_STATUSES.has(operation.status)
    && (ATTENTION_OPERATION_STATUSES.has(operation.status) || operation.attention !== null)
}

function parentRollup(children, parent) {
  if (children.length === 0) {
    return parent.batchConstructionIncomplete === true
      ? { status: 'failed', attention: null, childIds: [] }
      : { status: 'prepared', attention: null, childIds: [] }
  }
  const childIds = children.map((child) => child.id)
  const terminal = children.filter((child) => TERMINAL_OPERATION_STATUSES.has(child.status))
  if (terminal.length === children.length) {
    if (parent.batchConstructionIncomplete === true) {
      return { status: 'partial', attention: null, childIds }
    }
    if (children.every((child) => child.status === 'completed')) {
      return { status: 'completed', attention: null, childIds }
    }
    if (children.every((child) => ['aborted', 'discarded'].includes(child.status))) {
      return { status: 'aborted', attention: null, childIds }
    }
    if (children.every((child) => child.status === 'failed')) {
      return { status: 'failed', attention: null, childIds }
    }
    return { status: 'partial', attention: null, childIds }
  }
  const attentionIds = children
    .filter(operationNeedsAttention)
    .map((child) => child.id)
  if (attentionIds.length > 0) {
    return {
      status: 'needs-attention',
      attention: { kind: 'children', operationIds: attentionIds },
      childIds,
    }
  }
  return { status: 'running', attention: null, childIds }
}

function sameRollup(operation, rollup) {
  return operation.status === rollup.status
    && JSON.stringify(operation.attention ?? null) === JSON.stringify(rollup.attention ?? null)
    && JSON.stringify(operation.childIds ?? []) === JSON.stringify(rollup.childIds ?? [])
}

export class OperationStore {
  constructor({ stateDir, maxOperations = 500, logger = console }) {
    this.stateDir = path.resolve(stateDir)
    this.maxOperations = maxOperations
    this.logger = logger
    this.operations = new Map()
    this.generation = 0
    this.cursor = 0
    this.writeTail = Promise.resolve()
    this.mutationTail = Promise.resolve()
    this.listeners = new Map()
    this.anyListeners = new Set()
  }

  get files() {
    return [
      path.join(this.stateDir, 'operations-a.json'),
      path.join(this.stateDir, 'operations-b.json'),
    ]
  }

  async load() {
    await mkdir(this.stateDir, { recursive: true })
    const reads = await Promise.all(this.files.map(readSnapshot))
    const snapshots = reads
      .map((row) => row.value)
      .filter((value) => value !== undefined)
      .sort((left, right) => right.generation - left.generation)
    const selected = snapshots[0]
    if (selected === undefined) {
      if (reads.some((row) => row.exists)) {
        throw new Error(`session-control state is corrupt in ${this.stateDir}`)
      }
      return this
    }
    this.generation = selected.generation
    let fallbackRevision = 0
    const operations = selected.operations.map((row) => normalizeOperation(row, ++fallbackRevision))
    this.cursor = selected.version === 2
      ? selected.cursor
      : Math.max(fallbackRevision, ...operations.map((row) => row.revision))
    this.operations = new Map(operations.map((row) => [row.id, row]))
    return this
  }

  get(id) {
    return this.operations.get(id)
  }

  list({ sourceId, targetId, parentId, includeTerminal = true } = {}) {
    return [...this.operations.values()]
      .filter((row) => sourceId === undefined || row.sourceId === sourceId)
      .filter((row) => targetId === undefined || row.targetId === targetId)
      .filter((row) => parentId === undefined || row.parentId === parentId)
      .filter((row) => includeTerminal || !TERMINAL_OPERATION_STATUSES.has(row.status))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  }

  findByMessage(messageId) {
    return [...this.operations.values()].find((row) => row.messageId === messageId)
  }

  findByNotificationMessage(messageId) {
    return [...this.operations.values()].find((row) => row.notification?.messageId === messageId)
  }

  findByIdempotency(sourceId, key) {
    return [...this.operations.values()].find((row) => (
      row.sourceId === sourceId && row.idempotencyKey === key
    ))
  }

  pendingCount({ sourceId, targetId } = {}) {
    return this.list({ sourceId, targetId, includeTerminal: false })
      .filter((row) => (row.kind ?? 'send') === 'send')
      .length
  }

  recentCount(sourceId, targetId, sinceMs) {
    return this.list({ sourceId, targetId }).filter((row) => (
      (row.kind ?? 'send') === 'send' && Date.parse(row.createdAt) >= sinceMs
    )).length
  }

  canInsert(count = 1) {
    if (!Number.isSafeInteger(count) || count < 0) return false
    let projected = this.operations.size
    const roots = this.list()
      .filter((row) => row.parentId === null && operationCanBePruned(row))
      .toReversed()
    while (projected + count > this.maxOperations && roots.length > 0) {
      const root = roots.shift()
      projected -= 1 + this.list({ parentId: root.id }).length
    }
    return projected + count <= this.maxOperations
  }

  async add(operation) {
    return await this.enqueueMutation(async () => {
      if (this.operations.has(operation.id)) throw new Error(`operation ${operation.id} already exists`)
      if (typeof operation.idempotencyKey === 'string'
        && this.findByIdempotency(operation.sourceId, operation.idempotencyKey) !== undefined) {
        throw new Error(`idempotency key ${operation.idempotencyKey} already exists for ${operation.sourceId}`)
      }
      const before = new Map(this.operations)
      const cursorBefore = this.cursor
      this.pruneForInsert()
      if (this.operations.size >= this.maxOperations) {
        throw new Error(`operation capacity reached (${this.maxOperations}); pending operations must settle first`)
      }
      const next = normalizeOperation({
        ...operation,
        revision: ++this.cursor,
      }, this.cursor)
      this.operations.set(next.id, next)
      const changed = [next, ...this.rollupParent(next.parentId)]
      try {
        await this.persist()
      } catch (error) {
        this.operations = before
        this.cursor = cursorBefore
        throw error
      }
      this.notifyAll(changed)
      return next
    })
  }

  async update(id, patch) {
    return await this.enqueueMutation(async () => {
      const current = this.operations.get(id)
      if (current === undefined) return undefined
      const before = new Map(this.operations)
      const cursorBefore = this.cursor
      const next = normalizeOperation({
        ...current,
        ...patch,
        id,
        revision: ++this.cursor,
        updatedAt: new Date().toISOString(),
      }, this.cursor)
      this.operations.set(id, next)
      const changed = [next, ...this.rollupParent(next.parentId)]
      if (next.kind === 'batch' && next.batchSealed === true) {
        changed.push(...this.rollupParent(next.id))
      }
      try {
        await this.persist()
      } catch (error) {
        this.operations = before
        this.cursor = cursorBefore
        throw error
      }
      this.notifyAll(changed)
      return this.operations.get(id)
    })
  }

  enqueueMutation(task) {
    const run = this.mutationTail.then(task, task)
    this.mutationTail = run.catch(() => {})
    return run
  }

  rollupParent(parentId) {
    if (typeof parentId !== 'string' || parentId.length === 0) return []
    const parent = this.operations.get(parentId)
    if (parent === undefined || parent.kind !== 'batch') return []
    if (parent.batchSealed === false) return []
    const children = this.list({ parentId })
    const rollup = parentRollup(children, parent)
    if (sameRollup(parent, rollup)) return []
    const next = normalizeOperation({
      ...parent,
      ...rollup,
      revision: ++this.cursor,
      updatedAt: new Date().toISOString(),
    }, this.cursor)
    this.operations.set(parentId, next)
    return [next]
  }

  pruneForInsert() {
    if (this.operations.size < this.maxOperations) return
    const roots = this.list()
      .filter((row) => row.parentId === null && operationCanBePruned(row))
      .toReversed()
    while (this.operations.size >= this.maxOperations && roots.length > 0) {
      const root = roots.shift()
      this.operations.delete(root.id)
      for (const child of this.list({ parentId: root.id })) this.operations.delete(child.id)
    }
  }

  subscribe(id, listener) {
    const rows = this.listeners.get(id) ?? new Set()
    rows.add(listener)
    this.listeners.set(id, rows)
    return () => {
      rows.delete(listener)
      if (rows.size === 0) this.listeners.delete(id)
    }
  }

  subscribeAny(listener) {
    this.anyListeners.add(listener)
    return () => this.anyListeners.delete(listener)
  }

  notifyAll(operations) {
    for (const operation of operations) {
      for (const listener of this.listeners.get(operation.id) ?? []) {
        try {
          listener(operation)
        } catch (error) {
          this.logger?.warn?.('session-control operation listener failed', error)
        }
      }
      for (const listener of this.anyListeners) {
        try {
          listener(operation)
        } catch (error) {
          this.logger?.warn?.('session-control operation listener failed', error)
        }
      }
    }
  }

  async waitForTerminal(id, { timeoutMs, signal }) {
    return await this.waitForAny([id], {
      timeoutMs,
      signal,
      predicate: (operation) => TERMINAL_OPERATION_STATUSES.has(operation.status),
    }).then((result) => result.operation ?? this.get(id))
  }

  async waitForAny(ids, { timeoutMs, signal, afterRevision = 0, predicate }) {
    const wanted = new Set(ids)
    const current = ids
      .map((id) => this.get(id))
      .filter((operation) => operation !== undefined)
      .find((operation) => operation.revision > afterRevision && predicate(operation))
    if (current !== undefined) return { operation: current, timedOut: false, cursor: this.cursor }
    return await new Promise((resolve) => {
      let settled = false
      let timeout
      let unsubscribe = () => {}
      const finish = (operation, timedOut) => {
        if (settled) return
        settled = true
        if (timeout !== undefined) clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        unsubscribe()
        resolve({ operation, timedOut, cursor: this.cursor })
      }
      const onAbort = () => finish(undefined, true)
      unsubscribe = this.subscribeAny((operation) => {
        if (wanted.has(operation.id)
          && operation.revision > afterRevision
          && predicate(operation)) finish(operation, false)
      })
      if (signal?.aborted) {
        finish(undefined, true)
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs <= 0) {
        queueMicrotask(() => finish(undefined, true))
      } else {
        timeout = setTimeout(() => finish(undefined, true), timeoutMs)
        timeout.unref?.()
      }
    })
  }

  async persist() {
    const task = async () => {
      const generation = this.generation + 1
      const file = this.files[generation % 2]
      const snapshot = JSON.stringify({
        version: 2,
        generation,
        cursor: this.cursor,
        operations: [...this.operations.values()],
      }, null, 2)
      const handle = await open(file, 'w', 0o600)
      try {
        await handle.writeFile(`${snapshot}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      this.generation = generation
    }
    this.writeTail = this.writeTail.then(task, task)
    await this.writeTail
  }

  async dispose() {
    await this.mutationTail
    await this.writeTail
    this.listeners.clear()
    this.anyListeners.clear()
  }
}

export function scanOperation(events, operation) {
  const pending = { 'next-turn': [], 'next-step': [] }
  let inboxOutcome
  let userIndex = -1

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data
      const list = pending[data.target]
      if (!Array.isArray(list)) continue
      const removed = list.slice(data.start, data.start + (data.removedCount ?? 0))
      list.splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []))
      if (removed.some((message) => message?.id === operation.messageId)) {
        inboxOutcome = data.outcome === 'canceled' ? 'discarded' : 'claimed'
      }
      if ((data.inserted ?? []).some((message) => message?.id === operation.messageId)) {
        inboxOutcome = 'queued'
      }
    }
    if (event.type === 'user/message' && event.data?.id === operation.messageId) {
      userIndex = index
      inboxOutcome = 'admitted'
    }
  }

  if (userIndex < 0) {
    if (inboxOutcome === 'queued') return { status: 'queued', attention: null }
    if (inboxOutcome === 'discarded') return { status: 'discarded', reason: 'inbox-discarded', attention: null }
    if (inboxOutcome === 'claimed') {
      return { status: 'failed', reason: 'claimed-without-durable-admission', attention: null }
    }
    return { status: 'failed', reason: 'delivery-unconfirmed-after-restart', attention: null }
  }

  let turn
  for (let index = userIndex - 1; index >= 0; index--) {
    if (events[index].type === 'turn/start') {
      turn = events[index].data.turn
      break
    }
  }
  if (turn === undefined) {
    return {
      status: 'delivery-unknown',
      attention: { kind: 'delivery', reason: 'missing-turn-boundary' },
    }
  }

  const replies = []
  const approvals = new Map()
  const calls = new Map()
  for (let index = userIndex + 1; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'assistant/message' && event.data?.turn === turn) {
      for (const block of event.data.message?.content ?? []) {
        if (block?.type === 'text' && block.text.length > 0) replies.push(block.text)
      }
    }
    if (event.type === 'approval/asked') approvals.set(event.data?.id, event.data)
    if (event.type === 'approval/decided') approvals.delete(event.data?.id)
    if (event.type === 'tool/call' && event.data?.turn === turn) calls.set(event.data?.callId, event.data)
    if (event.type === 'tool/result' && event.data?.turn === turn) calls.delete(event.data?.callId)
    if (event.type === 'turn/end' && event.data?.turn === turn) {
      const reason = event.data.reason?.kind ?? 'unknown'
      return {
        status: reason === 'completed' ? 'completed' : 'aborted',
        turn,
        reason,
        reply: replies.join('\n\n').slice(0, 3000),
        attention: null,
      }
    }
  }
  if (approvals.size > 0) {
    return {
      status: 'awaiting-approval',
      turn,
      reply: replies.join('\n\n').slice(0, 3000),
      attention: {
        kind: 'approval',
        approvals: [...approvals.values()].map((row) => ({
          id: row.id,
          toolName: row.toolName,
          reason: row.reason ?? null,
        })),
      },
    }
  }
  const questions = [...calls.values()].filter((call) => call.name === 'ask_user_question')
  if (questions.length > 0) {
    return {
      status: 'awaiting-input',
      turn,
      reply: replies.join('\n\n').slice(0, 3000),
      attention: { kind: 'user-input', callIds: questions.map((call) => call.callId) },
    }
  }
  return {
    status: 'running',
    turn,
    reply: replies.join('\n\n').slice(0, 3000),
    attention: null,
  }
}
