import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  apply,
  makeApi,
  publicOperation,
  reconcileOperation,
  registerControllerTools,
} from '../lib/index.js'
import { OperationStore } from '../lib/state-store.js'

function makeAgent(id, cwd, { status = 'idle', events = [] } = {}) {
  const inbox = []
  inbox.remove = (messageId) => {
    const index = inbox.findIndex((message) => message.id === messageId)
    if (index < 0) return false
    inbox.splice(index, 1)
    return true
  }
  const tools = new Map()
  const session = {
    header: { id, cwd },
    events,
    append(type, data) {
      const event = { seq: this.events.length, type, data }
      this.events.push(event)
      return event
    },
  }
  return {
    id,
    status,
    options: { provider: 'test', model: 'test-model' },
    session,
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

function installFakeScheduleTools(agent) {
  agent.tools.set('schedule_create', {
    async execute(args, exec) {
      assert.equal(exec.agent, agent)
      const id = `schedule-${agent.session.events.filter((event) => (
        event.type === 'schedule/change' && event.data?.operation === 'create'
      )).length + 1}`
      const now = Date.now()
      const record = args.after_seconds !== undefined
        ? {
          id,
          kind: 'after',
          prompt: args.prompt,
          afterSeconds: args.after_seconds,
          scheduledAt: new Date(now + args.after_seconds * 1000).toISOString(),
        }
        : {
          id,
          kind: 'every',
          prompt: args.prompt,
          everySeconds: args.every_seconds,
          scheduledAt: new Date(now + args.every_seconds * 1000).toISOString(),
        }
      agent.session.append('schedule/change', { version: 1, operation: 'create', schedule: record })
      return { ...record, state: 'scheduled', deliveryMode: 'session-local' }
    },
  })
  agent.tools.set('schedule_delete', {
    async execute(args, exec) {
      assert.equal(exec.agent, agent)
      agent.session.append('schedule/change', { version: 1, operation: 'delete', id: args.id })
      return { id: args.id, deleted: true }
    },
  })
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-control-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const source = makeAgent('controller', 'D:\\work')
  const target = makeAgent('target', 'D:\\work')
  const otherWorkspace = makeAgent('other', 'D:\\other')
  const agents = [source, target, otherWorkspace]
  const workspaces = []
  const store = await new OperationStore({ stateDir: directory, maxOperations: 50 }).load()
  t.after(() => store.dispose())
  const ctx = {
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      list: () => [...agents],
      isOwnedBy: () => false,
      async create(options) {
        const agent = makeAgent(options.sessionId, options.meta?.cwd)
        agent.options = options.agentOptions ?? {}
        agent.session.header = { id: options.sessionId, ...options.meta }
        if (options.seed !== undefined) agent.session.events.push(...options.seed)
        agents.push(agent)
        await options.setup?.(agent.ctx)
        return {
          agent,
          async dispose() {
            const index = agents.indexOf(agent)
            if (index >= 0) agents.splice(index, 1)
          },
        }
      },
    },
    sessions: { async flush() {} },
    tools: { get: (name, agent) => agent.tools.get(name) },
    workspaceRegistry: {
      list: () => [...workspaces],
      async resolveByPath(value) {
        const resolved = path.resolve(value)
        return workspaces.find((workspace) => workspace.path === resolved)
      },
      async create(value, title) {
        const resolved = path.resolve(value)
        const existing = workspaces.find((workspace) => workspace.path === resolved)
        if (existing !== undefined) return existing
        const sessionIds = []
        const workspace = {
          id: `workspace-${workspaces.length + 1}`,
          path: resolved,
          title: title ?? path.basename(resolved),
          sessionIds,
          createdAt: '2026-08-18T00:00:00.000Z',
          updatedAt: '2026-08-18T00:00:00.000Z',
          async attachSession(id) {
            if (!sessionIds.includes(id)) sessionIds.unshift(id)
          },
          async status() { return 'ok' },
        }
        workspaces.unshift(workspace)
        return workspace
      },
    },
    get() { return undefined },
    sessionPersistence: {
      async list() { return [] },
      async inspect(id) {
        throw new Error(`missing persisted session ${id}`)
      },
    },
  }
  const config = {
    sameWorkspaceOnly: true,
    maxPendingPerTarget: 3,
    maxPendingPerSource: 10,
    rateLimitPerMinute: 5,
    maxOperations: 50,
  }
  const lifecycle = { ownedHandles: new Map(), overrides: new Map(), scheduleCoordinator: null }
  const api = makeApi(ctx, config, store, new Set(['controller', 'second-controller']), lifecycle)
  return { source, target, otherWorkspace, agents, store, api, ctx, config, lifecycle }
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

test('cross-workspace control is enabled when the deployment switch is false', async (t) => {
  const { source, otherWorkspace, api, config } = await fixture(t)
  config.sameWorkspaceOnly = false
  const result = await api.send({
    target_id: otherWorkspace.id,
    content: '跨工作区验收',
    idempotency_key: 'cross-workspace-enabled-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(result.ok, true)
  assert.equal(otherWorkspace.inbox.length, 1)
})

test('controller tools register only in the supplied scoped context', async (t) => {
  const { source, store, api } = await fixture(t)
  const cleanup = registerControllerTools(source.ctx, api, store)
  assert.deepEqual([...source.tools.keys()].sort(), [
    'session_batch_send',
    'session_cancel',
    'session_events',
    'session_interrupt',
    'session_manage',
    'session_open',
    'session_operations',
    'session_project_open',
    'session_schedule_create',
    'session_schedule_delete',
    'session_schedule_list',
    'session_send',
    'session_status',
    'session_wait',
    'session_wait_many',
    'session_workspace_add',
    'session_workspace_list',
  ])
  await cleanup()
  assert.equal(source.tools.size, 0)
})

test('terminal public operations never expose stale attention', () => {
  const row = publicOperation({
    id: 'terminal-with-stale-attention',
    kind: 'lifecycle',
    sourceId: 'controller',
    targetId: 'target',
    idempotencyKey: 'terminal-attention-001',
    contentHash: 'hash',
    status: 'completed',
    attention: { kind: 'offline', reason: 'stale' },
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:01.000Z',
  })
  assert.equal(row.needs_attention, false)
  assert.equal(row.attention, null)
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

test('batch send creates a durable parent graph and is idempotent', async (t) => {
  const { source, target, store, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  const args = {
    idempotency_key: 'batch-parent-001',
    items: [
      { target_id: target.id, content: 'task one', idempotency_key: 'batch-child-001' },
      { target_id: target.id, content: 'task two', idempotency_key: 'batch-child-002' },
    ],
  }
  const first = await api.batchSend(args, exec)
  assert.equal(first.ok, true)
  assert.equal(first.operation.kind, 'batch')
  assert.equal(first.children.length, 2)
  assert.equal(target.inbox.length, 2)
  const parentId = first.operation.operation_id
  const childIds = store.get(parentId).childIds
  assert.equal(childIds.length, 2)

  const duplicate = await api.batchSend(args, exec)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.operation.operation_id, parentId)
  assert.equal(target.inbox.length, 2)

  for (const childId of childIds) await store.update(childId, { status: 'completed' })
  assert.equal(store.get(parentId).status, 'completed')
})

test('wait many returns terminal or attention changes with a durable cursor', async (t) => {
  const { source, target, store, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  const sent = await api.send({
    target_id: target.id,
    content: 'wait-many',
    idempotency_key: 'wait-many-001',
  }, exec)
  const id = sent.operation.operation_id
  await store.update(id, {
    status: 'awaiting-approval',
    attention: { kind: 'approval', approvals: [{ id: 'approval-1' }] },
  })
  const first = await api.waitMany({ operation_ids: [id], timeout_ms: 0 }, exec)
  assert.equal(first.timed_out, false)
  assert.equal(first.triggered_operation_id, id)
  assert.equal(first.operations[0].needs_attention, true)
  const second = await api.waitMany({
    operation_ids: [id],
    after_cursor: first.cursor,
    timeout_ms: 0,
  }, exec)
  assert.equal(second.timed_out, true)
  await assert.rejects(() => api.waitMany({
    operation_ids: [id],
    after_cursor: 'broken',
    timeout_ms: 0,
  }, exec), /cursor/u)
})

test('cancel removes only the exact queued operation', async (t) => {
  const { source, target, store, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  const sent = await api.send({
    target_id: target.id,
    content: 'cancel exact',
    idempotency_key: 'cancel-exact-001',
  }, exec)
  const result = await api.cancelOperations({
    operation_ids: [sent.operation.operation_id],
    reason: 'test cancellation',
  }, exec)
  assert.equal(result.results[0].outcome, 'removed-from-inbox')
  assert.equal(target.inbox.length, 0)
  assert.equal(store.get(sent.operation.operation_id).status, 'discarded')
})

test('session open creates and forks through the core factory with idempotency', async (t) => {
  const { source, agents, api, ctx, lifecycle } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  ctx.llm = { async resolveCallConfig(config) { return config } }
  const created = await api.openSession({
    mode: 'create',
    idempotency_key: 'open-create-001',
    reasoning_effort: 'high',
  }, exec)
  assert.equal(created.ok, true)
  assert.equal(created.workspace_isolated, false)
  assert.equal(created.reasoning_effort, 'high')
  assert.equal(lifecycle.overrides.get(created.session_id).reasoningEffort, 'high')
  assert.equal(agents.some((agent) => agent.id === created.session_id), true)
  const duplicate = await api.openSession({
    mode: 'create',
    idempotency_key: 'open-create-001',
    reasoning_effort: 'high',
  }, exec)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.session_id, created.session_id)
  const suspended = await api.manageSession({
    action: 'suspend',
    target_id: created.session_id,
    idempotency_key: 'manage-suspend-001',
  }, exec)
  assert.equal(suspended.status, 'cold')
  assert.equal(suspended.operation.status, 'completed')
  assert.equal(suspended.operation.attention, null)
  assert.equal(suspended.operation.needs_attention, false)
  assert.equal(agents.some((agent) => agent.id === created.session_id), false)

  source.session.events.push(
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: 'u-1' } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
  const forked = await api.openSession({
    mode: 'fork',
    source_session_id: source.id,
    idempotency_key: 'open-fork-001',
  }, exec)
  assert.equal(forked.ok, true)
  const child = agents.find((agent) => agent.id === forked.session_id)
  assert.equal(child.session.header.parentSession, source.id)
  assert.equal(child.session.events.length, 3)
})

test('live recovery never scans lifecycle operations as relay sends', async (t) => {
  const { source, target, ctx, store } = await fixture(t)
  const now = new Date().toISOString()
  await store.add({
    id: 'lifecycle-not-a-send',
    kind: 'lifecycle',
    parentId: null,
    childIds: [],
    sourceId: source.id,
    sourceCwd: source.session.header.cwd,
    targetId: target.id,
    targetCwd: target.session.header.cwd,
    idempotencyKey: 'lifecycle-recovery-001',
    contentHash: 'lifecycle-hash',
    messageId: '',
    status: 'prepared',
    createdAt: now,
    updatedAt: now,
  })
  await reconcileOperation(ctx, store, store.get('lifecycle-not-a-send'))
  assert.equal(store.get('lifecycle-not-a-send').status, 'prepared')
})

test('controller creates, redacts, lists, and deletes native target schedules', async (t) => {
  const { source, target, api, store } = await fixture(t)
  installFakeScheduleTools(target)
  const exec = { agent: source, signal: new AbortController().signal }
  const created = await api.createSchedule({
    target_id: target.id,
    prompt: 'SCHEDULE-SECRET',
    after_seconds: 60,
    idempotency_key: 'schedule-create-001',
  }, exec)
  assert.equal(created.ok, true)
  assert.equal(created.operation.status, 'scheduled')
  assert.equal(created.schedule.id, 'schedule-1')

  const redacted = await api.listSchedules({ target_id: target.id }, exec)
  assert.equal(redacted.count, 1)
  assert.equal(redacted.schedules[0].prompt, undefined)
  assert.equal(typeof redacted.schedules[0].prompt_sha256, 'string')
  const revealed = await api.listSchedules({ target_id: target.id, include_prompt: true }, exec)
  assert.equal(revealed.schedules[0].prompt, 'SCHEDULE-SECRET')

  const deleted = await api.deleteSchedule({
    target_id: target.id,
    schedule_id: 'schedule-1',
    idempotency_key: 'schedule-delete-001',
  }, exec)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.result.deleted, true)
  assert.equal(store.get(created.operation.operation_id).status, 'completed')
  assert.equal((await api.listSchedules({ target_id: target.id }, exec)).count, 0)
})

test('uncertain native schedule persistence is never retried blindly', async (t) => {
  const { source, target, api, store } = await fixture(t)
  let createCalls = 0
  target.tools.set('schedule_create', {
    async execute() {
      createCalls += 1
      return {
        code: 'persistence_uncertain',
        id: 'schedule-uncertain',
        message: 'simulated flush uncertainty',
      }
    },
  })
  const args = {
    target_id: target.id,
    prompt: 'UNCERTAIN-SCHEDULE',
    after_seconds: 60,
    idempotency_key: 'schedule-uncertain-001',
  }
  const exec = { agent: source, signal: new AbortController().signal }
  const first = await api.createSchedule(args, exec)
  assert.equal(first.ok, false)
  assert.equal(first.uncertain, true)
  assert.equal(first.operation.status, 'delivery-unknown')
  assert.equal(first.operation.needs_attention, true)

  const duplicate = await api.createSchedule(args, exec)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.operation.operation_id, first.operation.operation_id)
  assert.equal(createCalls, 1)
  assert.equal(store.get(first.operation.operation_id).status, 'delivery-unknown')
})

test('project open creates a directory, registers its workspace, and attaches a new session', async (t) => {
  const { source, agents, api, ctx } = await fixture(t)
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-project-open-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = path.join(root, 'new-project')
  const result = await api.openProject({
    path: projectPath,
    title: 'New Project',
    idempotency_key: 'project-open-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(result.ok, true)
  assert.equal(result.directory_created, true)
  assert.equal((await stat(projectPath)).isDirectory(), true)
  assert.equal(ctx.workspaceRegistry.list().length, 1)
  assert.equal(ctx.workspaceRegistry.list()[0].title, 'New Project')
  assert.deepEqual(ctx.workspaceRegistry.list()[0].sessionIds, [result.session_id])
  assert.equal(agents.find((agent) => agent.id === result.session_id).session.header.cwd, projectPath)

  const duplicate = await api.openProject({
    path: projectPath,
    title: 'New Project',
    idempotency_key: 'project-open-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.session_id, result.session_id)
})

test('project open reports attach failure as partial without hiding created state', async (t) => {
  const { source, agents, api, ctx, store } = await fixture(t)
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-project-partial-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = path.join(root, 'partial-project')
  const createWorkspace = ctx.workspaceRegistry.create.bind(ctx.workspaceRegistry)
  ctx.workspaceRegistry.create = async (...args) => {
    const workspace = await createWorkspace(...args)
    workspace.attachSession = async () => {
      throw new Error('simulated attach failure')
    }
    return workspace
  }

  const result = await api.openProject({
    path: projectPath,
    idempotency_key: 'project-partial-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.match(result.error, /simulated attach failure/)
  assert.equal((await stat(projectPath)).isDirectory(), true)
  assert.equal(ctx.workspaceRegistry.list().length, 1)
  assert.equal(agents.some((agent) => agent.id === result.session_id), true)
  assert.equal(store.get(result.operation.operation_id).status, 'partial')
})

test('status and paged events can inspect same-workspace cold sessions without resuming', async (t) => {
  const { source, ctx, store, api } = await fixture(t)
  const coldHeader = { id: 'cold-session', cwd: 'D:\\work' }
  const coldEvents = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: { id: 'cold-u-1', content: [{ type: 'text', text: 'one' }] } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'two' }] } } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  ctx.sessionPersistence.list = async () => [coldHeader]
  ctx.sessionPersistence.inspect = async (id) => {
    assert.equal(id, coldHeader.id)
    return { meta: coldHeader, events: coldEvents }
  }
  const cleanup = registerControllerTools(source.ctx, api, store)
  const exec = { agent: source, signal: new AbortController().signal }
  const status = await source.tools.get('session_status').execute({ include_cold: true }, exec)
  assert.equal(status.sessions.some((row) => row.id === coldHeader.id && row.status === 'cold'), true)
  const page = await source.tools.get('session_events').execute({
    target_id: coldHeader.id,
    limit: 2,
  }, exec)
  assert.deepEqual(page.events.map((event) => event.seq), [2, 3])
  assert.equal(page.page.has_older, true)
  const older = await source.tools.get('session_events').execute({
    target_id: coldHeader.id,
    limit: 2,
    before_seq: page.page.older_before_seq,
  }, exec)
  assert.deepEqual(older.events.map((event) => event.seq), [0, 1])
  await cleanup()
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
