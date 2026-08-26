import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  apply,
  createApprovalBroker,
  makeApi,
  publicOperation,
  reconcileOperation,
  reconcilePermissionOperation,
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
    id,
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
    steer(message) {
      inbox.push(message)
      this.status = 'running'
    },
    cancel() {
      this.status = 'idle'
    },
    async whenIdle() {},
  }
}

function makePermissionRuntime(request = async () => 'rejected') {
  const specs = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  }
  const current = (events) => events.findLast((event) => event.type === 'permission/preset')
    ?.data?.preset ?? 'workspace-write'
  const approval = {
    setPolicy(agent, policy) {
      const previous = agent.session.events.findLast((event) => event.type === 'approval/policy')
        ?.data?.policy
      if (previous !== policy) agent.session.append('approval/policy', { policy })
    },
    request,
  }
  const permissionPresets = {
    names: Object.keys(specs),
    current,
    resolve(name) {
      const spec = specs[name]
      if (spec === undefined) throw new Error(`unknown permission preset ${name}`)
      return spec
    },
    apply(session, name, setApproval) {
      const spec = this.resolve(name)
      if (current(session.events) !== name) session.append('permission/preset', { preset: name })
      const sandbox = session.events.findLast((event) => event.type === 'sandbox/mode')?.data?.mode
      if (sandbox !== spec.sandbox) session.append('sandbox/mode', { mode: spec.sandbox })
      setApproval(spec.approval)
    },
  }
  return { approval, permissionPresets }
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
  const source = makeAgent('controller', '/workspace/work')
  const target = makeAgent('target', '/workspace/work')
  const otherWorkspace = makeAgent('other', '/workspace/other')
  const agents = [source, target, otherWorkspace]
  const workspaces = []
  const permissions = makePermissionRuntime()
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
      async resume(options) {
        const inspection = await ctx.sessionPersistence.inspect(options.resumeSessionId)
        const agent = makeAgent(
          options.resumeSessionId,
          inspection.meta.cwd,
          { events: [...inspection.events] },
        )
        agent.options = options.agentOptions ?? {}
        agent.session.header = { ...inspection.meta }
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
    ...permissions,
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
  source.session.events.push({
    type: 'session/title',
    data: { title: '来源任务' },
  })
  const exec = { agent: source, signal: new AbortController().signal }
  const args = {
    target_id: target.id,
    content: '只回复 EXACT-OK',
    idempotency_key: 'send-exact-001',
  }
  const first = await api.send(args, exec)
  assert.equal(first.ok, true)
  assert.equal(first.operation.queued, false)
  assert.equal(first.operation.completion_delivery, 'followup')
  assert.equal(target.inbox.length, 1)

  await assert.rejects(() => api.send({
    ...args,
    content: 'different content',
  }, exec), /幂等键/u)
  assert.equal(target.inbox[0].source.plugin, 'dsh-session-control')
  assert.deepEqual(target.inbox[0].source, {
    kind: 'plugin',
    plugin: 'dsh-session-control',
    form: 'relay',
    provenanceVersion: 1,
    senderDisplayName: 'DSH',
    senderSessionId: source.id,
    senderSessionTitle: '来源任务',
    targetSessionId: target.id,
    operationId: first.operation.operation_id,
  })
  assert.match(target.inbox[0].content[0].text, /<dsh-session-relay>/u)

  const duplicate = await api.send(args, exec)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.operation.operation_id, first.operation.operation_id)
  assert.equal(target.inbox.length, 1)
})

test('send supports explicit manual completion delivery and binds it to idempotency', async (t) => {
  const { source, target, api } = await fixture(t)
  const exec = { agent: source, signal: new AbortController().signal }
  const args = {
    target_id: target.id,
    content: 'manual polling task',
    idempotency_key: 'send-manual-001',
    completion_delivery: 'manual',
  }
  const first = await api.send(args, exec)
  assert.equal(first.operation.completion_delivery, 'manual')
  const duplicate = await api.send(args, exec)
  assert.equal(duplicate.duplicate, true)
  await assert.rejects(() => api.send({ ...args, completion_delivery: 'followup' }, exec), /completion_delivery/u)
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
  const thief = makeAgent('second-controller', '/workspace/work')
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
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(otherWorkspace.inbox.length, 1)
})

test('cross-workspace cold discovery expands persistence with Workspace registry membership', async (t) => {
  const { source, api, config, ctx, store } = await fixture(t)
  config.sameWorkspaceOnly = false
  const workspace = await ctx.workspaceRegistry.create('/workspace/cold-project', 'Cold Project')
  await workspace.attachSession('cold-other-workspace')
  ctx.sessionPersistence.list = async () => []
  ctx.sessionPersistence.inspect = async (id) => {
    assert.equal(id, 'cold-other-workspace')
    return {
      meta: { id, cwd: '/workspace/cold-project' },
      events: [{ seq: 7, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }],
    }
  }
  const cleanup = registerControllerTools(source.ctx, api, store)
  const result = await source.tools.get('session_status').execute({ include_cold: true }, {
    agent: source,
    signal: new AbortController().signal,
  })
  await cleanup()
  const discovered = result.sessions.find((session) => session.id === 'cold-other-workspace')
  assert.equal(discovered.status, 'cold')
  assert.equal(discovered.cwd, '/workspace/cold-project')
})

test('full-access controller persistently raises and lowers child permission without replay', async (t) => {
  const { source, target, api, ctx } = await fixture(t)
  source.session.append('permission/preset', { preset: 'danger-full-access' })
  const exec = { agent: source, signal: new AbortController().signal }
  const raisedArgs = {
    target_id: target.id,
    permission_preset: 'danger-full-access',
    reason: 'unattended build requires full access',
    idempotency_key: 'permission-full-001',
  }
  const raised = await api.setPermission(raisedArgs, exec)
  assert.equal(raised.ok, true)
  assert.equal(raised.changed, true)
  assert.equal(raised.operation.permission_authorization, 'autonomous-by-danger-full-access-controller')
  assert.equal(ctx.permissionPresets.current(target.session.events), 'danger-full-access')

  const lowered = await api.setPermission({
    target_id: target.id,
    permission_preset: 'read-only',
    reason: 'work completed; reduce authority',
    idempotency_key: 'permission-lower-001',
  }, exec)
  assert.equal(lowered.ok, true)
  assert.equal(ctx.permissionPresets.current(target.session.events), 'read-only')

  const duplicate = await api.setPermission(raisedArgs, exec)
  assert.equal(duplicate.duplicate, true)
  assert.equal(ctx.permissionPresets.current(target.session.events), 'read-only')
  const viewed = await api.getPermission({ target_id: target.id }, exec)
  assert.equal(viewed.permission_preset, 'read-only')
  assert.equal(viewed.approval_policy, 'ask')
})

test('workspace-write Full access elevation is approved in the child turn and hidden from the model', async (t) => {
  const { source, target, api, ctx, store } = await fixture(t)
  let approvalAgent
  let approvalReasonText
  ctx.approval.request = async (request) => {
    approvalAgent = request.agent
    approvalReasonText = request.reason
    return 'allowed-once'
  }
  const queued = await api.setPermission({
    target_id: target.id,
    permission_preset: 'danger-full-access',
    reason: 'child needs autonomous deployment access',
    idempotency_key: 'permission-child-ui-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(queued.pending_child_approval, true)
  assert.equal(queued.operation.permission_authorization, 'pending-human-at-target')
  assert.equal(target.inbox.length, 1)
  await assert.rejects(() => api.setPermission({
    target_id: target.id,
    permission_preset: 'read-only',
    reason: 'must not race the pending elevation',
    idempotency_key: 'permission-child-race-001',
  }, { agent: source, signal: new AbortController().signal }), /未决权限操作/u)
  const internal = target.inbox[0]
  target.session.append('turn/start', { turn: 1 })
  const decision = await api.handlePermissionPreStep({
    agent: target,
    messages: [internal],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [internal] }))
  assert.equal(approvalAgent, target)
  assert.match(approvalReasonText, /持久权限/u)
  assert.match(approvalReasonText, /child needs autonomous deployment access/u)
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(ctx.permissionPresets.current(target.session.events), 'danger-full-access')
  const settled = store.get(queued.operation.operation_id)
  assert.equal(settled.status, 'completed')
  assert.equal(settled.permissionAuthorization, 'approved-once-by-human-at-target')
})

test('workspace-write child rejection and stale target state perform zero permission change', async (t) => {
  const { source, agents, api, ctx, store } = await fixture(t)
  const rejectedTarget = makeAgent('permission-rejected-target', '/workspace/work')
  const staleTarget = makeAgent('permission-stale-target', '/workspace/work')
  agents.push(rejectedTarget, staleTarget)
  let approvals = 0
  ctx.approval.request = async () => {
    approvals += 1
    return 'rejected'
  }
  const rejected = await api.setPermission({
    target_id: rejectedTarget.id,
    permission_preset: 'danger-full-access',
    reason: 'rejection path',
    idempotency_key: 'permission-rejected-001',
  }, { agent: source, signal: new AbortController().signal })
  rejectedTarget.session.append('turn/start', { turn: 1 })
  await api.handlePermissionPreStep({
    agent: rejectedTarget,
    messages: [rejectedTarget.inbox[0]],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [rejectedTarget.inbox[0]] }))
  assert.equal(ctx.permissionPresets.current(rejectedTarget.session.events), 'workspace-write')
  assert.equal(store.get(rejected.operation.operation_id).status, 'failed')

  const stale = await api.setPermission({
    target_id: staleTarget.id,
    permission_preset: 'danger-full-access',
    reason: 'stale path',
    idempotency_key: 'permission-stale-001',
  }, { agent: source, signal: new AbortController().signal })
  staleTarget.session.append('permission/preset', { preset: 'read-only' })
  staleTarget.session.append('turn/start', { turn: 1 })
  await api.handlePermissionPreStep({
    agent: staleTarget,
    messages: [staleTarget.inbox[0]],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [staleTarget.inbox[0]] }))
  assert.equal(ctx.permissionPresets.current(staleTarget.session.events), 'read-only')
  assert.equal(store.get(stale.operation.operation_id).status, 'failed')
  assert.equal(approvals, 1)
})

test('session creation can request child-approved initial Full access', async (t) => {
  const { source, agents, api, ctx, store } = await fixture(t)
  ctx.approval.request = async () => 'allowed-once'
  const created = await api.openSession({
    mode: 'create',
    permission_preset: 'danger-full-access',
    idempotency_key: 'create-permission-full-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(created.ok, true)
  assert.equal(created.permission_pending, true)
  assert.equal(created.operation.child_ids.length, 1)
  const child = agents.find((agent) => agent.id === created.session_id)
  assert.equal(ctx.permissionPresets.current(child.session.events), 'workspace-write')
  child.session.append('turn/start', { turn: 1 })
  await api.handlePermissionPreStep({
    agent: child,
    messages: [child.inbox[0]],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [child.inbox[0]] }))
  assert.equal(ctx.permissionPresets.current(child.session.events), 'danger-full-access')
  assert.equal(store.get(created.operation.child_ids[0]).status, 'completed')
})

test('full-access controller changes a cold child permission and returns it to cold', async (t) => {
  const { source, target, agents, api, ctx } = await fixture(t)
  source.session.append('permission/preset', { preset: 'danger-full-access' })
  agents.splice(agents.indexOf(target), 1)
  let persistedEvents = []
  ctx.sessionPersistence.inspect = async (id) => {
    assert.equal(id, target.id)
    return { meta: { id, cwd: '/workspace/work' }, events: [...persistedEvents] }
  }
  ctx.sessions.flush = async (session) => {
    if (session.id === target.id) persistedEvents = [...session.events]
  }
  const changed = await api.setPermission({
    target_id: target.id,
    permission_preset: 'read-only',
    reason: 'cold maintenance lockdown',
    idempotency_key: 'permission-cold-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(changed.ok, true)
  assert.equal(agents.some((agent) => agent.id === target.id), false)
  const viewed = await api.getPermission({ target_id: target.id }, {
    agent: source,
    signal: new AbortController().signal,
  })
  assert.equal(viewed.status, 'cold')
  assert.equal(viewed.permission_preset, 'read-only')
})

test('restart never replays an unconfirmed child permission approval', async (t) => {
  const { source, target, store, ctx } = await fixture(t)
  target.session.append('turn/start', { turn: 1 })
  target.session.append('approval/asked', {
    id: 'permission-restart-approval',
    toolName: 'session_permission_set',
    reason: 'pending permission change',
  })
  const now = new Date().toISOString()
  const operation = await store.add({
    id: 'permission-restart-operation',
    kind: 'permission',
    action: 'set',
    parentId: null,
    childIds: [],
    sourceId: source.id,
    sourceCwd: source.session.header.cwd,
    targetId: target.id,
    targetCwd: target.session.header.cwd,
    idempotencyKey: 'permission-restart-001',
    contentHash: 'permission-restart-hash',
    messageId: 'permission-restart-message',
    status: 'awaiting-approval',
    turn: 1,
    attention: { kind: 'approval' },
    previousPermissionPreset: 'workspace-write',
    requestedPermissionPreset: 'danger-full-access',
    createdAt: now,
    updatedAt: now,
  })
  await reconcilePermissionOperation(ctx, store, operation)
  const recovered = store.get(operation.id)
  assert.equal(recovered.status, 'failed')
  assert.match(recovered.reason, /permission-restart-not-replayed/u)
  assert.equal(ctx.permissionPresets.current(target.session.events), 'workspace-write')
})

test('permission persistence uncertainty is reconciled without replaying the change', async (t) => {
  const { source, target, api, ctx, store } = await fixture(t)
  source.session.append('permission/preset', { preset: 'danger-full-access' })
  ctx.sessions.flush = async () => { throw new Error('simulated flush uncertainty') }
  const args = {
    target_id: target.id,
    permission_preset: 'danger-full-access',
    reason: 'exercise persistence uncertainty',
    idempotency_key: 'permission-uncertain-001',
  }
  const uncertain = await api.setPermission(args, {
    agent: source,
    signal: new AbortController().signal,
  })
  assert.equal(uncertain.ok, false)
  assert.equal(uncertain.operation.status, 'delivery-unknown')
  assert.equal(ctx.permissionPresets.current(target.session.events), 'danger-full-access')
  const duplicate = await api.setPermission(args, {
    agent: source,
    signal: new AbortController().signal,
  })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.operation.status, 'delivery-unknown')
  await reconcilePermissionOperation(ctx, store, store.get(uncertain.operation.operation_id))
  assert.equal(store.get(uncertain.operation.operation_id).status, 'completed')
})

test('full-access controller decides a delegated target approval exactly once', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-approval-broker-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new OperationStore({ stateDir: directory, maxOperations: 50 }).load()
  t.after(() => store.dispose())
  const source = makeAgent('controller', '/workspace/work')
  const target = makeAgent('target', '/workspace/work')
  const ctx = {
    logger: { warn() {} },
    agents: {
      get: (id) => [source, target].find((agent) => agent.id === id),
      list: () => [source, target],
      isOwnedBy: () => false,
    },
    permissionPresets: { current: () => 'danger-full-access' },
  }
  const broker = createApprovalBroker(ctx, store, new Set([source.id]), {
    timeoutMs: 60000,
    confirmationTimeoutMs: 1000,
  })
  t.after(() => broker.dispose())
  const now = new Date().toISOString()
  const operation = await store.add({
    id: 'managed-resume-1',
    kind: 'lifecycle',
    action: 'resume',
    parentId: null,
    childIds: [],
    sourceId: source.id,
    sourceCwd: source.session.header.cwd,
    targetId: target.id,
    targetCwd: target.session.header.cwd,
    idempotencyKey: 'managed-resume-key-1',
    contentHash: 'managed-resume-hash',
    messageId: '',
    status: 'completed',
    turn: null,
    attention: null,
    createdAt: now,
    updatedAt: now,
  })
  target.session.append('turn/start', { turn: 1 })
  target.session.append('approval/asked', {
    id: 'approval-delegated-1',
    toolName: 'pwsh',
    callId: 'call-delegated-1',
    reason: 'write outside target workspace',
  })
  let childUiCalls = 0
  const request = broker.handleRequest({
    agent: target,
    toolName: 'pwsh',
    callId: 'call-delegated-1',
    reason: 'write outside target workspace',
    signal: new AbortController().signal,
  }, async () => {
    childUiCalls += 1
    return 'rejected'
  })
  const listed = broker.list(source)
  assert.equal(listed.delegation_enabled, true)
  assert.equal(listed.count, 1)
  assert.equal(source.inbox.length, 1)
  assert.equal(source.inbox[0].source.form, 'approval-notice')

  request.then(async (outcome) => {
    const decided = target.session.append('approval/decided', {
      id: 'approval-delegated-1',
      outcome,
    })
    await broker.observeDecision(target.session, decided)
  })
  const args = {
    approval_id: 'approval-delegated-1',
    approval_fingerprint: listed.approvals[0].approval_fingerprint,
    outcome: 'allowed-once',
    idempotency_key: 'approval-decision-001',
  }
  await assert.rejects(() => broker.decide(source, {
    ...args,
    approval_fingerprint: 'stale-fingerprint',
    idempotency_key: 'approval-decision-stale-001',
  }), /fingerprint/u)
  const decided = await broker.decide(source, args)
  assert.equal(decided.ok, true, JSON.stringify(decided))
  assert.equal(decided.confirmed, true)
  assert.equal(decided.operation.approval_outcome, 'allowed-once')
  assert.equal(childUiCalls, 0)
  const duplicate = await broker.decide(source, args)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.operation.operation_id, decided.operation.operation_id)
})

test('workspace-write controller leaves target approval in the child UI', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-approval-child-ui-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new OperationStore({ stateDir: directory, maxOperations: 50 }).load()
  t.after(() => store.dispose())
  const source = makeAgent('controller', '/workspace/work')
  const target = makeAgent('target', '/workspace/work')
  let preset = 'danger-full-access'
  const ctx = {
    logger: { warn() {} },
    agents: {
      get: (id) => [source, target].find((agent) => agent.id === id),
      list: () => [source, target],
      isOwnedBy: () => false,
    },
    permissionPresets: { current: () => preset },
  }
  const broker = createApprovalBroker(ctx, store, new Set([source.id]), { timeoutMs: 60000 })
  t.after(() => broker.dispose())
  const now = new Date().toISOString()
  const operation = await store.add({
    id: 'delegated-send-2',
    kind: 'send',
    parentId: null,
    childIds: [],
    sourceId: source.id,
    sourceCwd: source.session.header.cwd,
    targetId: target.id,
    targetCwd: target.session.header.cwd,
    idempotencyKey: 'delegated-send-key-2',
    contentHash: 'delegated-send-hash-2',
    messageId: 'relay-message-2',
    status: 'running',
    turn: 1,
    attention: null,
    createdAt: now,
    updatedAt: now,
  })
  target.session.append('turn/start', { turn: 1 })
  broker.routeFromOperation(operation, 1)
  target.session.append('approval/asked', {
    id: 'approval-delegated-2',
    toolName: 'pwsh',
    callId: 'call-delegated-2',
  })
  let childUiCalls = 0
  const request = broker.handleRequest({
    agent: target,
    toolName: 'pwsh',
    callId: 'call-delegated-2',
    signal: new AbortController().signal,
  }, async () => {
    childUiCalls += 1
    return 'rejected'
  })
  assert.equal(broker.list(source).count, 1)
  preset = 'workspace-write'
  broker.fallbackSource(source.id)
  assert.equal(await request, 'rejected')
  assert.equal(childUiCalls, 1)
  const listed = broker.list(source)
  assert.equal(listed.delegation_enabled, false)
  assert.equal(listed.handling, 'child-session-ui')
  assert.equal(listed.count, 0)
})

test('scheduled autonomous turn routes approval back to its full-access controller', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-schedule-approval-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = await new OperationStore({ stateDir: directory, maxOperations: 50 }).load()
  t.after(() => store.dispose())
  const source = makeAgent('controller', '/workspace/work')
  const target = makeAgent('target', '/workspace/scheduled')
  let preset = 'danger-full-access'
  const ctx = {
    logger: { warn() {} },
    agents: {
      get: (id) => [source, target].find((agent) => agent.id === id),
      list: () => [source, target],
      isOwnedBy: () => false,
    },
    permissionPresets: { current: () => preset },
  }
  const broker = createApprovalBroker(ctx, store, new Set([source.id]), { timeoutMs: 60000 })
  t.after(() => broker.dispose())
  const now = new Date().toISOString()
  const operation = await store.add({
    id: 'schedule-operation-1',
    kind: 'schedule',
    action: 'create',
    parentId: null,
    childIds: [],
    sourceId: source.id,
    sourceCwd: source.session.header.cwd,
    targetId: target.id,
    targetCwd: target.session.header.cwd,
    idempotencyKey: 'schedule-route-key-1',
    contentHash: 'schedule-route-hash-1',
    messageId: '',
    scheduleId: 'schedule-42',
    status: 'completed',
    turn: null,
    attention: null,
    createdAt: now,
    updatedAt: now,
  })
  target.session.append('turn/start', { turn: 8 })
  const reminder = {
    id: 'schedule-message-1',
    content: [{
      type: 'text',
      text: '[SCHEDULE REMINDER]\nschedule_id_json: "schedule-42"\nreminder_prompt_json: "continue"',
    }],
    source: { kind: 'plugin', plugin: 'schedule' },
  }
  target.session.append('user/message', reminder)
  assert.equal(broker.routeFromMessage(target.session, reminder), true)
  target.session.append('approval/asked', {
    id: 'approval-schedule-1',
    toolName: 'pwsh',
    callId: 'schedule-call-1',
  })
  let childUiCalls = 0
  const request = broker.handleRequest({
    agent: target,
    toolName: 'pwsh',
    callId: 'schedule-call-1',
    signal: new AbortController().signal,
  }, async () => {
    childUiCalls += 1
    return 'rejected'
  })
  const listed = broker.list(source)
  assert.equal(listed.count, 1)
  assert.deepEqual(listed.approvals[0].operation_ids, [operation.id])
  preset = 'workspace-write'
  broker.fallbackSource(source.id)
  assert.equal(await request, 'rejected')
  assert.equal(childUiCalls, 1)
})

test('controller tools register only in the supplied scoped context', async (t) => {
  const { source, store, api } = await fixture(t)
  const cleanup = registerControllerTools(source.ctx, api, store)
  assert.deepEqual([...source.tools.keys()].sort(), [
    'session_approval_decide',
    'session_approval_list',
    'session_batch_send',
    'session_cancel',
    'session_events',
    'session_interrupt',
    'session_manage',
    'session_open',
    'session_operations',
    'session_permission_get',
    'session_permission_set',
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
    permission_preset: 'read-only',
    idempotency_key: 'project-open-001',
  }, { agent: source, signal: new AbortController().signal })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.directory_created, true)
  assert.equal((await stat(projectPath)).isDirectory(), true)
  assert.equal(ctx.workspaceRegistry.list().length, 1)
  assert.equal(ctx.workspaceRegistry.list()[0].title, 'New Project')
  assert.deepEqual(ctx.workspaceRegistry.list()[0].sessionIds, [result.session_id])
  const projectAgent = agents.find((agent) => agent.id === result.session_id)
  assert.equal(projectAgent.session.header.cwd, projectPath)
  assert.equal(ctx.permissionPresets.current(projectAgent.session.events), 'read-only')
  assert.equal(result.permission_operation.requested_permission_preset, 'read-only')

  const duplicate = await api.openProject({
    path: projectPath,
    title: 'New Project',
    permission_preset: 'read-only',
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
  const coldHeader = { id: 'cold-session', cwd: '/workspace/work' }
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
  const source = makeAgent('controller', '/workspace/work')
  const target = makeAgent('target', '/workspace/work')
  const agents = [source, target]
  const listeners = new Map()
  const cleanups = []
  let registeredSkill
  let permissionPreset = 'workspace-write'
  const permissions = makePermissionRuntime()
  permissions.permissionPresets.current = () => permissionPreset
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    agents: {
      get: (id) => agents.find((agent) => agent.id === id),
      list: () => [...agents],
      isOwnedBy: () => false,
    },
    sessions: { async flush() {} },
    sessionPersistence: { async inspect() { return { events: [] } } },
    skills: {
      register(skill) {
        registeredSkill = skill
        return () => {}
      },
    },
    systemPrompt: { section() { return () => {} } },
    ...permissions,
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
    provide(name, value) {
      this[name] = value
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
    approvalDelegationTimeoutMs: 60000,
  })
  assert.equal(typeof ctx.dshSessionControlExecutionPolicyResolver, 'function')
  assert.equal(typeof ctx.dshSessionControlExecutionPolicyVerifier?.verifyTargetSessionPolicy, 'function')
  const resolvedPolicy = await ctx.dshSessionControlExecutionPolicyResolver({ exec: { agent: target }, request: { cwd: target.session.header.cwd } })
  const verifiedPolicy = await ctx.dshSessionControlExecutionPolicyVerifier.verifyTargetSessionPolicy({ exec: { agent: target }, policy: resolvedPolicy })
  assert.equal(verifiedPolicy.authority, 'dsh-session-control')
  assert.equal(registeredSkill.name, 'dsh-session-control')
  assert.match(registeredSkill.content, /session_project_open/u)
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

  const childElevation = await preExecute({
    name: 'session_permission_set',
    agent: source,
    arguments: {
      target_id: target.id,
      permission_preset: 'danger-full-access',
      reason: 'child UI owns this elevation',
      idempotency_key: 'permission-route-child-001',
    },
  }, () => ({ kind: 'allow' }))
  assert.equal(childElevation.kind, 'allow')
  const sourceApprovedLowering = await preExecute({
    name: 'session_permission_set',
    agent: source,
    arguments: {
      target_id: target.id,
      permission_preset: 'read-only',
      reason: 'reduce child authority',
      idempotency_key: 'permission-route-lower-001',
    },
  }, () => ({ kind: 'allow' }))
  assert.equal(sourceApprovedLowering.kind, 'ask')
  assert.match(sourceApprovedLowering.reason, /read-only/u)

  permissionPreset = 'danger-full-access'
  const autonomousExec = {
    name: 'session_send',
    agent: source,
    arguments: {
      target_id: target.id,
      content: 'AUTONOMOUS-CONTENT',
      idempotency_key: 'autonomous-test-001',
    },
  }
  const autonomous = preExecute(autonomousExec, () => ({ kind: 'allow' }))
  assert.equal(autonomous.kind, 'allow')
  await source.tools.get('session_send').execute(autonomousExec.arguments, autonomousExec)
  assert.match(target.inbox.at(-1).content[0].text, /delegated-by-danger-full-access-controller/u)
  const autonomousPermission = await preExecute({
    name: 'session_permission_set',
    agent: source,
    arguments: {
      target_id: target.id,
      permission_preset: 'read-only',
      reason: 'full controller can lower autonomously',
      idempotency_key: 'permission-route-full-001',
    },
  }, () => ({ kind: 'allow' }))
  assert.equal(autonomousPermission.kind, 'allow')

  for (const cleanup of cleanups.toReversed()) await cleanup?.()
  assert.equal(source.tools.size, 0)
})
