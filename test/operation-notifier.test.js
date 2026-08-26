import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createOperationNotifier } from '../lib/operation-notifier.js'
import { OperationStore } from '../lib/state-store.js'

async function eventually(predicate, message = 'condition did not settle') {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

function makeSource(id = 'controller') {
  const nextTurn = []
  return {
    id,
    session: { id, events: [] },
    inbox: { nextTurn, nextStep: [] },
    followup(message) { nextTurn.push(message) },
  }
}

function operation(overrides = {}) {
  const now = '2026-08-26T00:00:00.000Z'
  return {
    id: overrides.id ?? 'operation-1',
    kind: 'send',
    parentId: null,
    childIds: [],
    sourceId: 'controller',
    sourceCwd: '/workspace',
    targetId: 'target',
    targetCwd: '/workspace',
    targetTitle: '目标任务',
    idempotencyKey: overrides.idempotencyKey ?? 'notifier-key-001',
    contentHash: overrides.contentHash ?? 'a'.repeat(64),
    messageId: overrides.messageId ?? 'relay-message-1',
    status: overrides.status ?? 'running',
    queued: false,
    durability: 'flushed',
    turn: 1,
    reason: overrides.reason ?? null,
    reply: overrides.reply ?? '',
    attention: overrides.attention ?? null,
    completionDelivery: overrides.completionDelivery ?? 'followup',
    notification: overrides.notification ?? null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-operation-notifier-'))
  const store = await new OperationStore({ stateDir, maxOperations: 50 }).load()
  const source = makeSource()
  let live = true
  let flushes = 0
  let flushError
  const ctx = {
    agents: { get: (id) => live && id === source.id ? source : undefined },
    sessions: { async flush() { flushes += 1; if (flushError) throw flushError } },
  }
  const notifier = createOperationNotifier({ ctx, store, logger: { warn() {} } })
  t.after(async () => {
    await notifier.dispose()
    await store.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  return {
    store,
    source,
    notifier,
    flushes: () => flushes,
    setLive(value) { live = value },
    setFlushError(value) { flushError = value },
  }
}

test('new send terminal state durably follows up its source exactly once', async (t) => {
  const { store, source, notifier, flushes } = await fixture(t)
  const row = await store.add(operation())
  notifier.start()
  await store.update(row.id, { status: 'completed', reason: 'completed', reply: '全部完成' })
  await eventually(() => source.inbox.nextTurn.length === 1)
  await eventually(() => store.get(row.id).notification?.state === 'delivered')

  const message = source.inbox.nextTurn[0]
  assert.equal(message.source.plugin, 'dsh-session-control')
  assert.equal(message.source.form, 'operation-terminal-report')
  assert.match(message.content[0].text, /全部完成/u)
  assert.equal(flushes(), 1)

  notifier.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(source.inbox.nextTurn.length, 1)
})

test('legacy/manual operation is never auto-reported', async (t) => {
  const { store, source, notifier } = await fixture(t)
  await store.add(operation({ status: 'completed', completionDelivery: 'manual' }))
  notifier.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(source.inbox.nextTurn.length, 0)
})

test('flush uncertainty retries the same durable message without duplicate followup', async (t) => {
  const { store, source, notifier, setFlushError } = await fixture(t)
  setFlushError(new Error('temporary flush failure'))
  await store.add(operation({ status: 'completed' }))
  notifier.start()
  await eventually(() => store.get('operation-1').notification?.state === 'delivery-unknown')
  assert.equal(source.inbox.nextTurn.length, 1)
  const messageId = source.inbox.nextTurn[0].id

  setFlushError(undefined)
  notifier.requestSource('controller')
  await eventually(() => store.get('operation-1').notification?.state === 'delivered')
  assert.equal(source.inbox.nextTurn.length, 1)
  assert.equal(source.inbox.nextTurn[0].id, messageId)
})

test('a resolved attention notice resets so a later equal attention state reports again', async (t) => {
  const { store, source, notifier } = await fixture(t)
  await store.add(operation())
  notifier.start()
  const attention = { kind: 'user-input', callIds: ['question-1'] }
  await store.update('operation-1', { status: 'awaiting-input', attention })
  await eventually(() => source.inbox.nextTurn.length === 1)
  await store.update('operation-1', { status: 'running', attention: null })
  await eventually(() => store.get('operation-1').notification === null)
  await store.update('operation-1', { status: 'awaiting-input', attention })
  await eventually(() => source.inbox.nextTurn.length === 2)
  assert.notEqual(source.inbox.nextTurn[0].id, source.inbox.nextTurn[1].id)
})

test('batch children produce one consolidated parent terminal report', async (t) => {
  const { store, source, notifier } = await fixture(t)
  await store.add(operation({
    id: 'batch-1',
    kind: 'batch',
    targetId: null,
    targetCwd: null,
    status: 'prepared',
    idempotencyKey: 'batch-notifier-001',
    messageId: '',
  }))
  await store.add(operation({
    id: 'child-1',
    parentId: 'batch-1',
    idempotencyKey: 'batch-child-001',
    completionDelivery: 'manual',
    status: 'running',
  }))
  await store.add(operation({
    id: 'child-2',
    parentId: 'batch-1',
    targetId: 'target-2',
    idempotencyKey: 'batch-child-002',
    contentHash: 'b'.repeat(64),
    messageId: 'relay-message-2',
    completionDelivery: 'manual',
    status: 'running',
  }))
  notifier.start()
  await store.update('child-1', { status: 'completed', reason: 'completed', reply: 'one' })
  await store.update('child-2', { status: 'failed', reason: 'error', reply: 'two' })
  await eventually(() => source.inbox.nextTurn.length === 1)
  const text = source.inbox.nextTurn[0].content[0].text
  assert.match(text, /"kind":"batch"/u)
  assert.match(text, /"status":"partial"/u)
  assert.match(text, /"operationId":"child-1"/u)
  assert.match(text, /"operationId":"child-2"/u)
})

test('restart reconciliation recognizes a durable message identity and does not replay it', async (t) => {
  const { store, source, notifier, setLive } = await fixture(t)
  setLive(false)
  await store.add(operation({ status: 'completed' }))
  notifier.start()
  await eventually(() => store.get('operation-1').notification?.state === 'reserved')
  const messageId = store.get('operation-1').notification.messageId
  source.session.events.push({
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', inserted: [{ id: messageId }] },
  })
  setLive(true)
  notifier.requestSource('controller')
  await eventually(() => store.get('operation-1').notification?.state === 'delivered')
  assert.equal(source.inbox.nextTurn.length, 0)
})
