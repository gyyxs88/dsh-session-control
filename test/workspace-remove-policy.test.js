import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { apply } from '../lib/index.js'

const root = os.tmpdir()
const stateDir = path.join(root, `main-policy-state-${Date.now()}`)
await mkdir(stateDir, { recursive: true })
const projectDir = path.join(stateDir, 'project')
const workspaces = new Map([['workspace-1', { id: 'workspace-1', path: projectDir, title: 'Project' }]])
let deleted = 0
const tools = new Map()
const source = {
  id: 'controller',
  session: { header: { id: 'controller', cwd: projectDir }, events: [], snapshotEvents() { return [...this.events] } },
  tools,
  ctx: { tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } },
}
const target = { id: 'target', session: { header: { id: 'target', cwd: projectDir }, events: [], snapshotEvents() { return [...this.events] } }, tools: new Map() }
const listeners = new Map()
const cleanups = []
let preset = 'danger-full-access'
const permissionPresets = {
  names: ['read-only', 'workspace-write', 'danger-full-access'],
  current: session => session === source.session ? preset : 'workspace-write',
  resolve: name => ({ sandbox: name, approval: name === 'danger-full-access' ? 'never' : 'ask' }),
}
const ctx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  agents: { get: id => [source, target].find(a => a.id === id), list: () => [source, target], isOwnedBy: () => false },
  sessions: { async flush() {} },
  sessionPersistence: { async inspect() { return { events: [] } } },
  skills: { register() { return () => {} } },
  systemPrompt: { section() { return () => {} } },
  permissionPresets,
  approval: { setPolicy() {}, async request() { return 'rejected' } },
  tools: { get: (name, agent) => agent.tools.get(name) },
  workspaceRegistry: {
    get: id => workspaces.get(id),
    async delete(id) { deleted++; return workspaces.delete(id) },
  },
  on(event, listener) { const rows = listeners.get(event) ?? []; rows.push(listener); listeners.set(event, rows); return () => listeners.set(event, rows.filter(x => x !== listener)) },
  effect(callback) { const cleanup = callback(); cleanups.push(cleanup); return cleanup },
  provide(name, value) { this[name] = value },
}
source.ctx.effect = ctx.effect.bind(ctx)
await apply(ctx, {
  controllerSessionIds: ['controller'], stateDir, sameWorkspaceOnly: true,
  maxPendingPerTarget: 3, maxPendingPerSource: 10, rateLimitPerMinute: 5,
  maxOperations: 50, approvalDelegationTimeoutMs: 60000,
})
const preExecute = listeners.get('tools/pre-execute')?.[0]
assert.equal(typeof preExecute, 'function')
assert.equal(source.tools.has('session_workspace_remove'), true)
assert.equal(target.tools.has('session_workspace_remove'), false)
const args = { workspace_id: 'workspace-1', expected_path: projectDir, idempotency_key: 'policy-remove-001' }
const decision = (agent = source, overrides = {}) => preExecute({ name: 'session_workspace_remove', agent, arguments: { ...args, ...overrides } }, () => ({ kind: 'allow' }))
assert.equal(decision(target).kind, 'deny')
preset = 'read-only'
assert.equal(decision().kind, 'deny')
preset = 'danger-full-access'
assert.equal(decision(source, { expected_path: path.join(stateDir, 'wrong') }).kind, 'deny')
if (process.platform === 'win32') {
  assert.equal(decision(source, { expected_path: '\\project' }).kind, 'deny')
  assert.equal(decision(source, { expected_path: 'C:project' }).kind, 'deny')
}
preset = 'workspace-write'
assert.equal(decision().kind, 'deny')
assert.equal(deleted, 0)
preset = 'danger-full-access'
listeners.get('permission-presets/catalog-changed')[0]()
assert.equal(decision().kind, 'allow')
const first = await source.tools.get('session_workspace_remove').execute(args, { agent: source })
assert.equal(first.ok, true)
assert.equal(deleted, 1)
assert.equal(decision().kind, 'allow')
const duplicate = await source.tools.get('session_workspace_remove').execute(args, { agent: source })
assert.equal(duplicate.duplicate, true)
assert.equal(deleted, 1)
assert.equal(decision(source, { idempotency_key: 'policy-remove-002' }).kind, 'deny')
for (const cleanup of cleanups.toReversed()) await cleanup?.()
assert.equal(source.tools.size, 0)
console.log(JSON.stringify({ status: 'passed', checks: 13, deleted, stateDir }))
