import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { sessionFormatCatalog, createSessionFormatCatalogWithChildren } from '@deepseek-ai/dsh-session-format-catalog'
import { releasedV3SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v2-to-v3'
import * as jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { makeApi, createApprovalBroker } from '../lib/index.js'
import { OperationStore } from '../lib/state-store.js'
import { createOperationNotifier } from '../lib/operation-notifier.js'
import { controlMessageSource, isControlMessage, isRelayMessage, currentTurnIsRelay } from '../lib/security.js'

const forms = ['relay', 'permission-change', 'approval-notice', 'operation-terminal-report', 'operation-attention-report']
const message = (source, id = 'message') => ({ id, role: 'user', source, content: [{ type: 'text', text: 'offline fixture' }] })
const event = data => ({ seq: 0, time: 1, type: 'user/message', surfaceOp: 'append', data })

test('official v4 refuses old wrappers and its v3 migration agrees with every new producer form', () => {
  assert.equal(sessionFormatCatalog.currentVersion, 4, 'must execute actual v4 SDK, never silently skip')
  for (const form of forms) {
    const old = message({ kind: 'plugin', plugin: 'dsh-session-control', form })
    assert.throws(() => sessionFormatCatalog.encodeCurrentEvent(event(old)), /producer-owned source kind/)
    const direct = message(controlMessageSource(form))
    assert.equal(direct.source.kind, 'plugin:dsh-session-control')
    assert.equal(direct.source.plugin, undefined)
    assert.doesNotThrow(() => sessionFormatCatalog.encodeCurrentEvent(event(direct)))
    const header = releasedV3SessionFormatCodec.encodeHeader({ version: 3, id: 'migration', createdAt: 1, isSeeded: false, delegationDepth: 0 }, 0)
    const restore = createSessionFormatCatalogWithChildren([]).createRestore(header, { recovery: 'strict', validation: 'current' })
    restore.decodeRow(event(old))
    const migrated = restore.finish()
    assert.deepEqual(migrated.events[0].data.source, direct.source)
    assert.equal(isControlMessage(migrated.events[0].data, form), true)
    assert.equal(isControlMessage(old, form), true)
  }
})

test('producer attribution rejects human, foreign, conflicting and form-spoofed sources', () => {
  for (const source of [undefined, { kind: 'user' }, { kind: 'user', plugin: 'dsh-session-control' },
    { kind: 'plugin' }, { kind: 'plugin', plugin: 'foreign' }, { kind: 'dsh-session-control' },
    { kind: 'plugin:foreign' }, { kind: 'plugin:dsh-session-control', plugin: 'foreign' }, { kind: 'schedule' }]) {
    for (const form of forms) assert.equal(isControlMessage(message({ ...source, form }), form), false)
  }
  for (const kind of ['plugin', 'plugin:dsh-session-control']) {
    const source = { kind, ...(kind === 'plugin' ? { plugin: 'dsh-session-control' } : {}), form: 'relay' }
    assert.equal(isRelayMessage(message(source)), true)
    assert.equal(currentTurnIsRelay({ session: { events: [{ type: 'turn/start', data: { turn: 1 } }, event(message(source))] } }), true)
    assert.equal(isRelayMessage(message({ ...source, form: 'approval-notice' })), false)
  }
})

async function eventually(predicate) {
  for (let i = 0; i < 150; i++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('notification did not durably settle')
}

test('official JSONL v4 persists send, both receipts, approval notice and suspend/reopen without a provider', async t => {
  assert.equal(sessionFormatCatalog.currentVersion, 4)
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-control-official-v4-'))
  const host = new Context()
  const fiber = host.plugin(jsonl, { root: path.join(root, 'sessions'), compression: 'none' })
  await fiber
  assert.equal(fiber.error, undefined)
  const persistence = host.sessionPersistence
  const store = await new OperationStore({ stateDir: path.join(root, 'operations'), maxOperations: 100 }).load()
  const agents = new Map(), writers = new Map(), offsets = new Map()
  let notifier, broker
  t.after(async () => {
    await notifier?.dispose(); await broker?.dispose()
    for (const writer of writers.values()) await writer.close()
    await store.dispose(); await fiber.dispose(); await host.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const flush = async session => {
    const events = session.snapshotEvents()
    await writers.get(session.id).append(events.slice(offsets.get(session.id) ?? 0))
    offsets.set(session.id, events.length)
    await writers.get(session.id).flush()
  }
  const add = async id => {
    const session = Session.create(id, undefined, { ...Session.create(id).header, cwd: root })
    writers.set(id, await persistence.create(session.header))
    const inbox = []
    const agent = { id, session, inbox, status: 'idle', options: {},
      followup(m) {
        // This is the official durable pending-inbox slot, before a turn consumes it.
        session.append('agent/inbox/spliced', { target: 'next-turn', inserted: [m], deleted: [] })
        inbox.push(m)
      }, steer(m) { this.followup(m) } }
    agents.set(id, agent)
    return agent
  }
  const source = await add('controller'), target = await add('target')
  const ctx = { agents: { get: id => agents.get(id), list: () => [...agents.values()], isOwnedBy: () => false },
    sessions: { flush }, sessionPersistence: persistence, logger: { warn() {} },
    permissionPresets: { current: session => session.id === source.id ? 'danger-full-access' : 'workspace-write' } }
  const lifecycle = { ownedHandles: new Map(), overrides: new Map() }
  const api = makeApi(ctx, { sameWorkspaceOnly: true, maxPendingPerTarget: 10, maxPendingPerSource: 10, rateLimitPerMinute: 10 }, store, new Set(), lifecycle)
  const args = { target_id: target.id, content: 'offline send', idempotency_key: 'official-v4-send-001' }
  const sent = await api.send(args, { agent: source })
  assert.equal(sent.ok, true)
  assert.equal(sent.operation.durability, 'flushed')
  assert.equal((await api.send(args, { agent: source })).duplicate, true)
  assert.equal(target.inbox.length, 1)
  notifier = createOperationNotifier({ ctx, store, logger: ctx.logger })
  notifier.start()
  await store.update(sent.operation.operation_id, { status: 'awaiting-input', attention: { kind: 'user-input', callIds: ['question'] } })
  await eventually(() => store.get(sent.operation.operation_id).notification?.state === 'delivered')
  assert.equal(source.inbox[0].source.form, 'operation-attention-report')
  await store.update(sent.operation.operation_id, { status: 'completed', attention: null, reason: 'completed', reply: 'offline done' })
  await eventually(() => source.inbox.length === 2 && store.get(sent.operation.operation_id).notification?.state === 'delivered')
  assert.equal(source.inbox[1].source.form, 'operation-terminal-report')
  target.session.append('turn/start', { turn: 1 })
  target.session.append('user/message', target.inbox[0], { surfaceOp: 'append' })
  target.session.append('approval/asked', { id: 'approval-v4', toolName: 'offline-tool', callId: 'call-v4' })
  broker = createApprovalBroker(ctx, store, new Set(), { timeoutMs: 1000 })
  assert.equal(broker.routeFromMessage(target.session, target.inbox[0]), true)
  const pending = broker.handleRequest({ agent: target, toolName: 'offline-tool', callId: 'call-v4', signal: new AbortController().signal }, async () => 'rejected')
  await eventually(() => source.inbox.some(m => m.source.form === 'approval-notice'))
  await broker.dispose()
  assert.equal(await pending, 'cancelled')
  await flush(source.session)
  lifecycle.ownedHandles.set(target.id, { async dispose() { await flush(target.session); await writers.get(target.id).close(); writers.delete(target.id); agents.delete(target.id) } })
  const suspended = await api.manageSession({ action: 'suspend', target_id: target.id, idempotency_key: 'official-v4-suspend-001' }, { agent: source })
  assert.equal(suspended.ok, true)
  assert.equal(suspended.status, 'cold')
  for (const agent of [source, target]) {
    await writers.get(agent.id)?.close(); writers.delete(agent.id)
    const reader = await persistence.open(agent.id, 'read')
    const result = await reader.read()
    await reader.close()
    assert.deepEqual(result.events, agent.session.snapshotEvents())
    const disk = await readFile(persistence.locate(agent.session.header).path, 'utf8')
    assert.equal(JSON.parse(disk.split('\n')[0]).version, 4)
    assert.ok(!disk.includes('"kind":"plugin"'))
    const restored = Session.fromRestore(agent.id, result.events, agent.session.header, 0, result.eventState)
    assert.deepEqual(restored.snapshotEvents().slice(0, result.events.length), result.events)
  }
})
