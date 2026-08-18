import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { OperationStore, scanOperation } from '../lib/state-store.js'

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
  assert.deepEqual(scanOperation(events, op), { status: 'queued' })
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
