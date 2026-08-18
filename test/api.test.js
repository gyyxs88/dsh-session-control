import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, makeApi, registerControllerTools } from '../lib/index.js'
import { OperationStore } from '../lib/state-store.js'

function makeAgent(id, cwd, { status = 'idle', events = [] } = {}) {
  const inbox = []
  const tools = new Map()
  return {
    id,
    status,
    options: { provider: 'test', model: 'test-model' },
    session: { header: { cwd }, events },
    inbox,
    ctx: {
      tools: {
        register(definition) {
          if (tools.has(definition.name)) throw new Error(`duplicate ${definition.name}`)
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
    },
    tools,
    followup(message) {
      inbox.push(message)
      this.status = 'running'
    },
    cancel() {
      this.status = 'idle'
    },
    async whenIdle() {},
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = makeAgent('controller', 'D:\\work')
  const target = makeAgent('target', 'D:\\work')
  const otherWorkspace = makeAgent('other', 'D:\\other')
  const agents = [source, target, otherWorkspace]
  const store = await new OperationStore({ stateDir: directory, maxOperations: 50 }).load()
  t.after(() => store.dispose())
  const ctx = {
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      list: () => [...agents],
      isOwnedBy: () => false,
    },
    sessions: { async flush() {} },
  }
  const config = {
    sameWorkspaceOnly: true,
    maxPendingPerTarget: 3,
    maxPendingPerSource: 10,
    rateLimitPerMinute: 5,
  }
  const api = makeApi(ctx, config, store, new Set(['controller', 'second-controller']))
  return { source, target, otherWorkspace, store, api }
}

test('send captures pre-followup status and is idempotent', async (t) => {
  const { source, target, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  const args = {
    target_id: target.id,
    content: '只回复 EXACT-OK',
    idempotency_key: 'send-exact-001',
  }
  const first = await api.send(args, exec)
  assert.equal(first.ok, true)
  assert.equal(first.operation.queued, false)
  assert.equal(target.inbox.length, 1)

  await assert.rejects(() => api.send({
    ...args,
    content: 'different content',
  }, exec), /幂等键/u)
  assert.equal(target.inbox[0].source.plugin, 'dsh-session-control')
  assert.match(target.inbox[0].content[0].text, /<dsh-session-relay>/u)

  const duplicate = await api.send(args, exec)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.operation.operation_id, first.operation.operation_id)
  assert.equal(target.inbox.length, 1)
})

test('cross-workspace target and operation theft are rejected', async (t) => {
  const { source, target, otherWorkspace, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  await assert.rejects(() => api.send({
    target_id: otherWorkspace.id,
    content: 'no',
    idempotency_key: 'cross-workspace-01',
  }, exec), /跨工作区/u)

  const sent = await api.send({
    target_id: target.id,
    content: 'ok',
    idempotency_key: 'owned-operation-01',
  }, exec)
  const thief = makeAgent('second-controller', 'D:\\work')
  await assert.rejects(() => api.wait({
    operation_id: sent.operation.operation_id,
    timeout_ms: 10,
  }, { agent: thief, signal: new AbortController().signal }), /不属于/u)
})

test('controller tools register only in the supplied scoped context', async (t) => {
  const { source, store, api } = await fixture(t)
  const cleanup = registerControllerTools(source.ctx, api, store)
  assert.deepEqual([...source.tools.keys()].sort(), [
    'session_events',
    'session_interrupt',
    'session_operations',
    'session_send',
    'session_status',
    'session_wait',
  ])
  await cleanup()
  assert.equal(source.tools.size, 0)
})

test('relay-started controller turn is denied even for an authorized id', async (t) => {
  const { source, target, api } = await fixture(t)
  source.session.events.push(
    { type: 'turn/start', data: { turn: 1 } },
    {
      type: 'user/message',
      data: {
        id: 'relay',
        source: { kind: 'plugin', plugin: 'dsh-session-control', form: 'relay' },
      },
    },
  )
  await assert.rejects(() => api.send({
    target_id: target.id,
    content: 'loop',
    idempotency_key: 'relay-loop-001',
  }, { agent: source, signal: new AbortController().signal }), /中继消息/u)
})

test('pending capacity and persistent rate limits fail closed', async (t) => {
  const { source, target, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  for (let index = 0; index < 3; index++) {
    await api.send({
      target_id: target.id,
      content: `pending-${index}`,
      idempotency_key: `pending-key-${index}`,
    }, exec)
  }
  await assert.rejects(() => api.send({
    target_id: target.id,
    content: 'overflow',
    idempotency_key: 'pending-overflow',
  }, exec), /未完成操作已达上限/u)
})

test('host apply mounts tools only for configured controller and asks with bound reason', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = makeAgent('controller', 'D:\\work')
  const target = makeAgent('target', 'D:\\work')
  const agents = [source, target]
  const listeners = new Map()
  const cleanups = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      list: () => [...agents],
      isOwnedBy: () => false,
    },
    sessions: { async flush() {} },
    sessionPersistence: { async inspect() { return { events: [] } } },
    systemPrompt: { section() { return () => {} } },
    tools: { get: (name, agent) => agent.tools.get(name) },
    on(event, listener) {
      const rows = listeners.get(event) ?? []
      rows.push(listener)
      listeners.set(event, rows)
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((row) => row !== listener))
    },
    effect(callback) {
      const cleanup = callback()
      cleanups.push(cleanup)
      return cleanup
    },
  }
  source.ctx.effect = (callback) => {
    const cleanup = callback()
    cleanups.push(cleanup)
    return cleanup
  }
  target.ctx.effect = source.ctx.effect

  await apply(ctx, {
    controllerSessionIds: ['controller'],
    stateDir: directory,
    sameWorkspaceOnly: true,
    maxPendingPerTarget: 3,
    maxPendingPerSource: 10,
    rateLimitPerMinute: 5,
    maxOperations: 50,
  })
  assert.equal(source.tools.has('session_send'), true)
  assert.equal(target.tools.has('session_send'), false)

  const preExecute = listeners.get('tools/pre-execute')[0]
  const decision = preExecute({
    name: 'session_send',
    agent: source,
    arguments: {
      target_id: target.id,
      content: 'VISIBLE-CONTENT',
      idempotency_key: 'approval-test-001',
    },
  }, () => ({ kind: 'allow' }))
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /VISIBLE-CONTENT/u)
  assert.match(decision.reason, /approval-test-001/u)

  for (const cleanup of cleanups.toReversed()) await cleanup?.()
  assert.equal(source.tools.size, 0)
})
