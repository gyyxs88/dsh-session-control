import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import Tools from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { CONTROL_TOOL_NAMES } from '../lib/security.js'

test('official Cordis Scope masks inherited management schemas and mounts independent Full Access children', async t => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'official-scope-'))
  const ctx = new Context()
  const agents = new Map(), presets = new Map(), scopes = []
  let fiber, deleted = 0
  t.after(async () => {
    await fiber?.dispose()
    for (const scope of scopes.toReversed()) await scope.dispose()
    await ctx.fiber.dispose()
    await rm(stateDir, { recursive: true, force: true })
  })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const workspace = { id: 'workspace-fixture', path: stateDir }
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  new Tools(ctx)
  ctx.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()], isOwnedBy: () => false })
  ctx.provide('sessions', { async flush() {} })
  ctx.provide('sessionPersistence', { async inspect() { throw Error('no production reads') } })
  ctx.provide('skills', { register: () => () => {} })
  ctx.provide('llm', {})
  ctx.provide('approval', { async request() { return 'rejected' }, setPolicy() {} })
  ctx.provide('permissionPresets', { current: session => presets.get(session) })
  ctx.provide('workspaceRegistry', { list: () => [], get: id => id === workspace.id ? workspace : undefined, async delete() { deleted++; return true } })
  const add = async (id, preset, parent) => {
    const agent = { id, status: 'idle', options: {}, session: { id, header: { id, cwd: stateDir, origin: parent ? 'subagent' : 'ordinary' }, snapshotEvents: () => [] } }
    const scope = createScope(ctx, agent, parent ? { parent } : undefined)
    agent.ctx = scope.ctx; scopes.push(scope); agents.set(id, agent); presets.set(agent.session, preset)
    await tick(); ctx.emit(scopeTarget(ctx, agent), 'agent/created', { agent }); await tick()
    return agent
  }
  const source = await add('source', 'danger-full-access')
  const earlyChild = await add('early-child', 'workspace-write', source)
  fiber = ctx.plugin(plugin, { stateDir, controllerSessionIds: [earlyChild.id], authorizeAllOrdinarySessions: true })
  await fiber; await tick()
  assert.equal(fiber.error, undefined)
  assert.equal(ctx.tools.schemas(source).length, CONTROL_TOOL_NAMES.length)
  assert.equal(ctx.tools.schemas(earlyChild).length, 0)
  const child = await add('child', 'workspace-write', source)
  assert.equal(ctx.tools.schemas(child).length, 0)
  const old = ctx.tools.get('session_workspace_list', source)
  assert.equal((await old.execute({}, { agent: source })).ok, true)
  const change = async (agent, preset, type = 'permission/preset') => {
    presets.set(agent.session, preset)
    ctx.emit(scopeTarget(ctx, agent), 'session/event', agent.session, { type, data: {} }); await tick()
  }
  await change(source, 'workspace-write')
  assert.equal(ctx.tools.schemas(source).length, 0)
  await assert.rejects(old.execute({}, { agent: source }), /控制权限/u)
  const lateChild = await add('late-child', 'workspace-write', source)
  assert.equal(ctx.tools.schemas(lateChild).length, 0)
  await change(source, 'danger-full-access', 'approval/policy')
  assert.equal(ctx.tools.schemas(child).length, 0)
  assert.equal(ctx.tools.schemas(lateChild).length, 0, 'a child created before the parent mounts must gain its inheritance mask on tools/change')
  await change(child, 'danger-full-access', 'approval/policy')
  assert.equal(ctx.tools.schemas(child).length, CONTROL_TOOL_NAMES.length)
  assert.notEqual(ctx.tools.get('session_workspace_list', child), ctx.tools.get('session_workspace_list', source))
  await change(source, 'workspace-write')
  assert.equal(ctx.tools.schemas(child).length, CONTROL_TOOL_NAMES.length)
  await change(child, 'workspace-write')
  assert.equal(ctx.tools.schemas(child).length, 0)
  await change(source, 'danger-full-access', 'approval/policy')
  const remove = ctx.tools.get('session_workspace_remove', source).execute({ workspace_id: workspace.id, expected_path: stateDir, idempotency_key: 'scope-race-001' }, { agent: source })
  await change(source, 'workspace-write')
  await assert.rejects(remove, /控制权限/u)
  assert.equal(deleted, 0)
  const gate = await ctx.waterfall(scopeTarget(ctx, source), 'tools/pre-execute', { agent: null, name: 'session_workspace_remove', arguments: {} }, () => ({ kind: 'allow' }))
  assert.equal(gate.kind, 'deny')
})
