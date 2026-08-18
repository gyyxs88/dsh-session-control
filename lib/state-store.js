import { mkdir, open, readFile } from 'node:fs/promises'
import path from 'node:path'

export const TERMINAL_OPERATION_STATUSES = new Set([
  'completed',
  'aborted',
  'discarded',
  'failed',
])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateSnapshot(value) {
  if (!isPlainObject(value) || value.version !== 1) return undefined
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return undefined
  if (!Array.isArray(value.operations)) return undefined
  if (!value.operations.every((row) => isPlainObject(row) && typeof row.id === 'string')) return undefined
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

export class OperationStore {
  constructor({ stateDir, maxOperations = 500, logger = console }) {
    this.stateDir = path.resolve(stateDir)
    this.maxOperations = maxOperations
    this.logger = logger
    this.operations = new Map()
    this.generation = 0
    this.writeTail = Promise.resolve()
    this.listeners = new Map()
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
    this.operations = new Map(selected.operations.map((row) => [row.id, row]))
    return this
  }

  get(id) {
    return this.operations.get(id)
  }

  list({ sourceId, targetId, includeTerminal = true } = {}) {
    return [...this.operations.values()]
      .filter((row) => sourceId === undefined || row.sourceId === sourceId)
      .filter((row) => targetId === undefined || row.targetId === targetId)
      .filter((row) => includeTerminal || !TERMINAL_OPERATION_STATUSES.has(row.status))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
  }

  findByMessage(messageId) {
    return [...this.operations.values()].find((row) => row.messageId === messageId)
  }

  findByIdempotency(sourceId, key) {
    return [...this.operations.values()].find((row) => (
      row.sourceId === sourceId && row.idempotencyKey === key
    ))
  }

  pendingCount({ sourceId, targetId } = {}) {
    return this.list({ sourceId, targetId, includeTerminal: false }).length
  }

  recentCount(sourceId, targetId, sinceMs) {
    return this.list({ sourceId, targetId }).filter((row) => (
      Date.parse(row.createdAt) >= sinceMs
    )).length
  }

  async add(operation) {
    if (this.operations.has(operation.id)) throw new Error(`operation ${operation.id} already exists`)
    this.pruneForInsert()
    if (this.operations.size >= this.maxOperations) {
      throw new Error(`operation capacity reached (${this.maxOperations}); pending operations must settle first`)
    }
    this.operations.set(operation.id, operation)
    this.notify(operation)
    try {
      await this.persist()
    } catch (error) {
      this.operations.delete(operation.id)
      throw error
    }
    return operation
  }

  async update(id, patch) {
    const current = this.operations.get(id)
    if (current === undefined) return undefined
    const next = {
      ...current,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    }
    this.operations.set(id, next)
    this.notify(next)
    await this.persist()
    return next
  }

  pruneForInsert() {
    if (this.operations.size < this.maxOperations) return
    const terminal = this.list().filter((row) => TERMINAL_OPERATION_STATUSES.has(row.status))
    while (this.operations.size >= this.maxOperations && terminal.length > 0) {
      const oldest = terminal.pop()
      this.operations.delete(oldest.id)
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

  notify(operation) {
    for (const listener of this.listeners.get(operation.id) ?? []) listener(operation)
  }

  async waitForTerminal(id, { timeoutMs, signal }) {
    const current = this.get(id)
    if (current === undefined || TERMINAL_OPERATION_STATUSES.has(current.status)) return current
    return await new Promise((resolve) => {
      let settled = false
      let timeout
      let unsubscribe = () => {}
      const finish = (value) => {
        if (settled) return
        settled = true
        if (timeout !== undefined) clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        unsubscribe()
        resolve(value)
      }
      const onAbort = () => finish(this.get(id))
      unsubscribe = this.subscribe(id, (operation) => {
        if (TERMINAL_OPERATION_STATUSES.has(operation.status)) finish(operation)
      })
      if (signal?.aborted) {
        finish(this.get(id))
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timeout = setTimeout(() => finish(this.get(id)), timeoutMs)
      timeout.unref?.()
    })
  }

  async persist() {
    const task = async () => {
      const generation = this.generation + 1
      const file = this.files[generation % 2]
      const snapshot = JSON.stringify({
        version: 1,
        generation,
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
    await this.writeTail
    this.listeners.clear()
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
    if (inboxOutcome === 'queued') return { status: 'queued' }
    if (inboxOutcome === 'discarded') return { status: 'discarded', reason: 'inbox-discarded' }
    if (inboxOutcome === 'claimed') {
      return { status: 'failed', reason: 'claimed-without-durable-admission' }
    }
    return { status: 'failed', reason: 'delivery-unconfirmed-after-restart' }
  }

  let turn
  for (let index = userIndex - 1; index >= 0; index--) {
    if (events[index].type === 'turn/start') {
      turn = events[index].data.turn
      break
    }
  }
  if (turn === undefined) return { status: 'delivery-unknown' }

  const replies = []
  for (let index = userIndex + 1; index < events.length; index++) {
    const event = events[index]
    if (event.type === 'assistant/message' && event.data?.turn === turn) {
      for (const block of event.data.message?.content ?? []) {
        if (block?.type === 'text' && block.text.length > 0) replies.push(block.text)
      }
    }
    if (event.type === 'turn/end' && event.data?.turn === turn) {
      const reason = event.data.reason?.kind ?? 'unknown'
      return {
        status: reason === 'completed' ? 'completed' : 'aborted',
        turn,
        reason,
        reply: replies.join('\n\n').slice(0, 3000),
      }
    }
  }
  return {
    status: 'running',
    turn,
    reply: replies.join('\n\n').slice(0, 3000),
  }
}
