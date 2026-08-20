import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  OperationStore,
  operationNeedsAttention,
  scanOperation,
} from '../lib/state-store.js'

function operation(id = 'op-1') {
  return {
    id,
    sourceId: 'source',
    targetId: 'target',
    messageId: `message-${id}`,
    idempotencyKey: `key-${id}`,
    contentHash: `hash-${id}`,
    status: 'prepared',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }
}

test('two-slot store survives reload and keeps the newest generation', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))

  const first = await new OperationStore({ stateDir: directory, maxOperations: 20 }).load()
  await first.add(operation())
  await first.update('op-1', { status: 'completed', reply: 'OK' })
  await first.dispose()

  const second = await new OperationStore({ stateDir: directory, maxOperations: 20 }).load()
  assert.equal(second.get('op-1').status, 'completed')
  assert.equal(second.get('op-1').reply, 'OK')
  assert.equal(second.findByIdempotency('source', 'key-op-1').id, 'op-1')
  await second.dispose()
})

test('scanOperation does not confuse cancellation of another queued message', () => {
  const op = operation()
  const other = { id: 'message-other' }
  const events = [
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 0, inserted: [{ id: op.messageId }] },
    },
    {
      type: 'agent/inbox/spliced',
      data: { target: 'next-turn', start: 1, inserted: [other] },
    },
    {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-turn',
        start: 1,
        removedCount: 1,
        inserted: [],
        outcome: 'canceled',
      },
    },
  ]
  assert.deepEqual(scanOperation(events, op), { status: 'queued', attention: null })
})

test('scanOperation correlates exact message to turn and reply', () => {
  const op = operation()
  const events = [
    { type: 'turn/start', data: { turn: 4 } },
    {
      type: 'user/message',
      data: { id: op.messageId, source: { kind: 'plugin' } },
    },
    {
      type: 'assistant/message',
      data: {
        turn: 4,
        message: { content: [{ type: 'text', text: 'EXACT-OK' }] },
      },
    },
    { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
  ]
  assert.deepEqual(scanOperation(events, op), {
    status: 'completed',
    turn: 4,
    reason: 'completed',
    reply: 'EXACT-OK',
    attention: null,
  })
})

test('waiter settles only for terminal transition', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new OperationStore({ stateDir: directory, maxOperations: 20 }).load()
  await store.add(operation())
  const waiting = store.waitForTerminal('op-1', { timeoutMs: 1000 })
  await store.update('op-1', { status: 'running' })
  await store.update('op-1', { status: 'completed' })
  assert.equal((await waiting).status, 'completed')
  await store.dispose()
})

test('batch parent rolls up attention and mixed terminal results', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new OperationStore({ stateDir: directory, maxOperations: 20 }).load()
  await store.add({
    ...operation('parent'),
    kind: 'batch',
    parentId: null,
    childIds: [],
    targetId: null,
  })
  await store.add({ ...operation('child-a'), parentId: 'parent' })
  await store.add({ ...operation('child-b'), parentId: 'parent' })
  await store.update('child-a', {
    status: 'awaiting-input',
    attention: { kind: 'user-input', callIds: ['call-1'] },
  })
  assert.equal(store.get('parent').status, 'needs-attention')
  assert.equal(operationNeedsAttention(store.get('parent')), true)
  await store.update('child-a', { status: 'completed', attention: null })
  await store.update('child-b', { status: 'failed', attention: null })
  assert.equal(store.get('parent').status, 'partial')
  await store.dispose()
})

test('scan operation reports unresolved approval and user input', () => {
  const op = operation()
  const base = [
    { seq: 0, type: 'turn/start', data: { turn: 2 } },
    { seq: 1, type: 'user/message', data: { id: op.messageId } },
  ]
  const approval = scanOperation([
    ...base,
    { seq: 2, type: 'approval/asked', data: { id: 'a-1', toolName: 'pwsh', reason: 'write' } },
  ], op)
  assert.equal(approval.status, 'awaiting-approval')
  assert.equal(approval.attention.approvals[0].id, 'a-1')

  const question = scanOperation([
    ...base,
    { seq: 2, type: 'tool/call', data: { turn: 2, callId: 'q-1', name: 'ask_user_question' } },
  ], op)
  assert.equal(question.status, 'awaiting-input')
  assert.deepEqual(question.attention.callIds, ['q-1'])
})

test('version one snapshots migrate to revision cursors', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'operations-a.json'), JSON.stringify({
    version: 1,
    generation: 4,
    operations: [operation('legacy')],
  }), 'utf8')
  const store = await new OperationStore({ stateDir: directory, maxOperations: 20 }).load()
  assert.equal(store.get('legacy').kind, 'send')
  assert.equal(store.get('legacy').revision, 1)
  await store.update('legacy', { status: 'completed' })
  assert.equal(store.get('legacy').revision > 1, true)
  await store.dispose()
})

test('state load fails closed when both durable slots are corrupt', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'operations-a.json'), '{broken', 'utf8')
  await writeFile(path.join(directory, 'operations-b.json'), '[]', 'utf8')
  await assert.rejects(
    () => new OperationStore({ stateDir: directory, maxOperations: 20 }).load(),
    /state is corrupt/u,
  )
})

test('concurrent inserts enforce one idempotency owner', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new OperationStore({ stateDir: directory, maxOperations: 20 }).load()
  const results = await Promise.allSettled([
    store.add(operation('race-a')),
    store.add({ ...operation('race-b'), idempotencyKey: 'key-race-a' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(store.list().length, 1)
  await store.dispose()
})

test('version two snapshots reject revisions beyond the durable cursor', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(path.join(directory, 'operations-a.json'), JSON.stringify({
    version: 2,
    generation: 1,
    cursor: 1,
    operations: [{ ...operation('future'), revision: 2 }],
  }), 'utf8')
  await assert.rejects(
    () => new OperationStore({ stateDir: directory, maxOperations: 20 }).load(),
    /state is corrupt/u,
  )
})

test('listener failures cannot turn a durable mutation into a failed call', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const warnings = []
  const store = await new OperationStore({
    stateDir: directory,
    maxOperations: 20,
    logger: { warn: (...args) => warnings.push(args) },
  }).load()
  store.subscribe('op-listener', () => { throw new Error('broken listener') })
  await store.add(operation('op-listener'))
  assert.equal(store.get('op-listener').status, 'prepared')
  assert.equal(warnings.length, 1)
  await store.dispose()
})
