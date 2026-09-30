import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, makeApi, createScheduleCoordinator, createApprovalBroker } from '../lib/index.js'
import { OperationStore } from '../lib/state-store.js'
import { isAuthorizedController } from '../lib/security.js'
import { createSessionControlExecutionPolicyServices } from '../lib/execution-policy-service.js'

function agent(id, origin) {
  const tools = new Map()
  const events = []
  const session = { id, header: { id, cwd: '/test/project', ...(origin ? { origin } : {}) },
    snapshotEvents: () => [...events], append(type, data) { const event = { seq: events.length, type, data, time: Date.now() }; events.push(event); session.observe?.(event); return event } }
  const inbox = []
  return { id, session, tools, inbox, status: 'idle', options: {}, followup: m => inbox.push(m),
    ctx: { effect: fn => fn(), tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } } } }
}

// Use the official current/derive/set implementations, with a synthetic projection.
// Source and target retain separate knob states; target defaults to workspace-write.
function permissionService() {
  const service = Object.create(PermissionPresetService.prototype)
  Object.defineProperty(service, 'ctx', { value: { shell: { sandboxMode: 'workspace-write' }, approval: { config: { policy: 'ask' } },
    sessionProjections: { stateOf(session) {
      const state = { preset: null, sandbox: null, approval: null, seeded: false }
      for (const event of session.snapshotEvents()) {
        if (event.type === 'permission/preset') state.preset = event.data.preset
        if (event.type === 'sandbox/mode') state.sandbox = event.data.mode
        if (event.type === 'approval/policy') state.approval = event.data.policy
      }
      return state
    } } } })
  Object.defineProperty(service, 'presets', { value: {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  } })
  return service
}

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'full-access-'))
  const store = await new OperationStore({ stateDir, maxOperations: 100 }).load()
  t.after(async () => { await store.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  const source = agent('unlisted-source')
  const target = agent('legacy-listed-target')
  const agents = [source, target]
  const permissions = permissionService()
  permissions.set(source.session, 'danger-full-access')
  const listeners = new Map()
  const cleanups = []
  const ctx = { logger: { info() {}, warn() {}, error() {} },
    agents: { get: id => agents.find(a => a.id === id), list: () => [...agents], isOwnedBy: () => false },
    permissionPresets: permissions, sessionPersistence: { async inspect() { throw Error('absent') } },
    sessions: { async flush() {} }, approval: { async request() { return 'rejected' }, setPolicy() {} },
    skills: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
    tools: { get: (name, a) => a.tools.get(name) },
    on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => listeners.set(name, list.filter(f => f !== fn)) },
    effect(fn) { const cleanup = fn(); cleanups.push(cleanup); return cleanup }, provide(name, value) { this[name] = value },
  }
  const config = { stateDir, controllerSessionIds: [target.id], authorizeAllOrdinarySessions: true,
    maxOperations: 100, maxPendingPerSource: 10, maxPendingPerTarget: 3, rateLimitPerMinute: 5 }
  const api = makeApi(ctx, config, store, new Set([target.id]))
  return { ctx, source, target, permissions, agents, store, api, config, listeners, cleanups }
}

test('official three-knob transitions and catalog changes unmount/regrant tools for an unlisted Full Access child', async t => {
  const f = await fixture(t)
  f.source.session.header.origin = 'subagent'
  await apply(f.ctx, f.config)
  t.after(async () => { for (const cleanup of f.cleanups.toReversed()) await cleanup?.() })
  assert.equal(f.source.tools.size, 22)
  assert.equal(f.target.tools.size, 0)
  const preExecute = f.listeners.get('tools/pre-execute')[0]
  for (const invalid of [null, undefined, {}, { id: '' }]) {
    assert.equal(preExecute({ name: 'session_workspace_list', agent: invalid }, () => ({ kind: 'allow' })).kind, 'deny')
    await assert.rejects(f.api.listWorkspaces({}, { agent: invalid }), /控制权限/u)
  }
  const old = f.source.tools.get('session_workspace_list')
  const transitions = []
  f.source.session.observe = event => {
    f.listeners.get('session/event')[0](f.source.session, event)
    transitions.push({ type: event.type, preset: f.permissions.current(f.source.session), mounted: f.source.tools.size > 0 })
  }
  f.permissions.set(f.source.session, 'workspace-write')
  assert.equal(f.source.tools.size, 0)
  await assert.rejects(old.execute({}, { agent: f.source }), /控制权限/u)
  f.permissions.set(f.source.session, 'danger-full-access')
  assert.deepEqual(transitions.slice(-3).map(r => r.mounted), [false, false, true])
  assert.deepEqual(transitions.slice(-3).map(r => r.type), ['permission/preset', 'sandbox/mode', 'approval/policy'])
  assert.equal(f.target.tools.size, 0)
  const spec = f.permissions.presets['danger-full-access']
  delete f.permissions.presets['danger-full-access']
  f.listeners.get('permission-presets/catalog-changed')[0]()
  assert.equal(f.source.tools.size, 0)
  f.permissions.presets['danger-full-access'] = spec
  f.listeners.get('permission-presets/catalog-changed')[0]()
  assert.equal(f.source.tools.size, 22)
})

for (const entry of ['remove', 'send', 'permission', 'schedule-create', 'schedule-delete', 'create']) {
  test(`downgrade during durable preparation prevents ${entry} side effects`, async t => {
    const f = await fixture(t)
    let effects = 0
    f.ctx.workspaceRegistry = { get: () => ({ id: 'workspace', path: path.resolve(f.config.stateDir) }), delete: async () => { effects++; return true } }
    f.target.followup = () => effects++
    f.target.tools.set('schedule_create', { execute: async () => { effects++; return {} } })
    f.target.tools.set('schedule_delete', { execute: async () => { effects++; return {} } })
    f.ctx.agents.create = async () => { effects++; throw Error('must not create') }
    const add = f.store.add.bind(f.store)
    f.store.add = async op => { const saved = await add(op); f.permissions.set(f.source.session, 'workspace-write'); return saved }
    const exec = { agent: f.source }
    let result
    if (entry === 'remove') result = await f.api.removeWorkspace({ workspace_id: 'workspace', expected_path: path.resolve(f.config.stateDir), idempotency_key: 'race-remove-001' }, exec)
    if (entry === 'send') result = await f.api.send({ target_id: f.target.id, content: 'blocked', idempotency_key: 'race-send-001' }, exec)
    if (entry === 'permission') result = await f.api.setPermission({ target_id: f.target.id, permission_preset: 'danger-full-access', reason: 'blocked', idempotency_key: 'race-permission-001' }, exec)
    if (entry === 'schedule-create') result = await f.api.createSchedule({ target_id: f.target.id, prompt: 'blocked', after_seconds: 60, idempotency_key: 'race-schedule-001' }, exec)
    if (entry === 'schedule-delete') result = await f.api.deleteSchedule({ target_id: f.target.id, schedule_id: 'schedule-1', idempotency_key: 'race-schedule-002' }, exec)
    if (entry === 'create') result = await f.api.openSession({ mode: 'create', idempotency_key: 'race-create-001' }, exec)
    assert.equal(result.ok, false)
    assert.equal(effects, 0)
    assert.equal(f.store.list()[0].status, 'failed')
    assert.equal(f.permissions.current(f.target.session), 'workspace-write')
  })
}

test('cross-session execution policy admits Full Access child sources and preserves ordinary coding targets', async t => {
  const f = await fixture(t)
  f.source.session.header.origin = 'subagent'
  const { resolver, verifier } = createSessionControlExecutionPolicyServices({ ctx: f.ctx, controllerSessionIds: [f.target.id] })
  const policy = await resolver({ exec: { agent: f.target } })
  const verified = await verifier.verifyTargetSessionPolicy({ exec: { agent: f.target }, policy: { ...policy, sourceSessionId: f.source.id } })
  assert.equal(verified.permission, 'workspace-write')
  f.permissions.set(f.source.session, 'read-only')
  await assert.rejects(verifier.verifyTargetSessionPolicy({ exec: { agent: f.target }, policy: { ...policy, sourceSessionId: f.source.id } }), e => e.code === 'EXECUTION_POLICY_SOURCE_UNAUTHORIZED')
  f.target.session.header.origin = 'subagent'
  await assert.rejects(resolver({ exec: { agent: f.target } }), /subagent/u)
})

test('missing service/session, unknown preset, exceptions and stale live identities fail closed at API entry', async t => {
  const f = await fixture(t)
  for (const value of ['workspace-write', 'read-only', 'session.readonly', 'custom', null, undefined]) {
    f.ctx.permissionPresets = { current: () => value }
    await assert.rejects(f.api.listWorkspaces({}, { agent: f.source }), /控制权限/u)
  }
  f.ctx.permissionPresets = { current() { throw Error('offline') } }
  await assert.rejects(f.api.listWorkspaces({}, { agent: f.source }), /控制权限/u)
  delete f.ctx.permissionPresets
  await assert.rejects(f.api.listWorkspaces({}, { agent: f.source }), /控制权限/u)
  f.ctx.permissionPresets = f.permissions
  assert.equal(isAuthorizedController({ ...f.source }, f.ctx), false)
  delete f.source.session
  await assert.rejects(f.api.listWorkspaces({}, { agent: f.source }), /控制权限/u)
})

test('restored schedule provenance does not authorize a downgraded or missing cold source', async t => {
  const f = await fixture(t)
  f.target.session.append('schedule/change', { version: 1, operation: 'create', schedule: {
    id: 'schedule-1', kind: 'after', title: 'blocked', prompt: 'blocked', afterSeconds: 1, scheduledAt: new Date(Date.now() - 10_000).toISOString(),
  } })
  const now = new Date().toISOString()
  await f.store.add({ id: 'scheduled-operation', kind: 'schedule', action: 'create', sourceId: f.source.id, targetId: f.target.id,
    sourceCwd: '/test/project', targetCwd: '/test/project', idempotencyKey: 'persist-schedule-001', contentHash: 'hash', messageId: '', status: 'scheduled',
    scheduleId: 'schedule-1', queued: null, durability: 'flushed', turn: null, attention: null, reason: null, reply: '', createdAt: now, updatedAt: now })
  let resumed = 0
  f.ctx.agents.resume = async () => { resumed++; throw Error('must not resume') }
  const sourceEvents = f.source.session.snapshotEvents()
  f.agents.splice(0, f.agents.length)
  const header = id => ({ ...Session.create(id).header, cwd: '/test/project' })
  f.ctx.sessionPersistence.inspect = async id => ({ meta: header(id), events: id === f.target.id ? f.target.session.snapshotEvents() : sourceEvents })
  // Revocation is appended to the fresh cold snapshot, with original Full Access history retained.
  sourceEvents.push({ seq: sourceEvents.length, time: Date.now(), type: 'sandbox/mode', data: { mode: 'workspace-write' } })
  const coordinator = createScheduleCoordinator(f.ctx, f.store, { ownedHandles: new Map(), overrides: new Map() })
  coordinator.start()
  await new Promise(resolve => setTimeout(resolve, 40))
  await coordinator.dispose()
  assert.equal(resumed, 0)
  assert.match(f.store.get('scheduled-operation').attention.reason, /撤权/u)
  f.ctx.sessionPersistence.inspect = async id => { if (id === f.source.id) throw Error('missing source'); return { meta: { id, cwd: '/test/project' }, events: f.target.session.snapshotEvents() } }
  const again = createScheduleCoordinator(f.ctx, f.store, { ownedHandles: new Map(), overrides: new Map() })
  again.start()
  await new Promise(resolve => setTimeout(resolve, 40))
  await again.dispose()
  assert.equal(resumed, 0)
  sourceEvents.pop()
  f.ctx.sessionPersistence.inspect = async id => ({ meta: header(id), events: id === f.target.id ? f.target.session.snapshotEvents() : sourceEvents })
  const regranted = createScheduleCoordinator(f.ctx, f.store, { ownedHandles: new Map(), overrides: new Map() })
  regranted.start()
  await new Promise(resolve => setTimeout(resolve, 40))
  await regranted.dispose()
  assert.ok(resumed >= 1, 'fresh cold Full Access snapshot may restore its own schedule; no remembered IDs or other controller fallback')
})

test('legacy pending permission request rechecks source both before and after target UI approval', async t => {
  for (const revokeDuringApproval of [false, true]) {
    const f = await fixture(t)
    const now = new Date().toISOString()
    const message = { id: 'legacy-permission-message', source: { kind: 'plugin', plugin: 'dsh-session-control', form: 'permission-change' } }
    await f.store.add({ id: 'legacy-permission-operation', kind: 'permission', action: 'set', sourceId: f.source.id, targetId: f.target.id,
      sourceCwd: '/test/project', targetCwd: '/test/project', idempotencyKey: 'legacy-permission-001', contentHash: 'hash', messageId: message.id,
      status: 'queued', queued: true, durability: 'flushed', turn: null, attention: null, reason: null, reply: '',
      previousPermissionPreset: 'workspace-write', requestedPermissionPreset: 'danger-full-access', createdAt: now, updatedAt: now })
    let approvals = 0
    f.ctx.approval.request = async () => { approvals++; f.permissions.set(f.source.session, 'workspace-write'); return 'allowed-once' }
    if (!revokeDuringApproval) f.permissions.set(f.source.session, 'workspace-write')
    const decision = await f.api.handlePermissionPreStep({ agent: f.target, messages: [message], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [message] }))
    assert.deepEqual(decision, { kind: 'enter', messages: [] })
    assert.equal(approvals, revokeDuringApproval ? 1 : 0)
    assert.equal(f.permissions.current(f.target.session), 'workspace-write')
    assert.equal(f.store.get('legacy-permission-operation').status, 'failed')
  }
})
