import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createRemoteProjectPort, startRemoteProjectBridge } from '../lib/remote-project-bridge.js'

function request(socketPath, messages) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const lines = []
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => {
      for (const message of messages) socket.write(`${JSON.stringify(message)}\n`)
    })
    socket.on('data', (chunk) => {
      buffer += chunk
      while (true) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        lines.push(JSON.parse(buffer.slice(0, index)))
        buffer = buffer.slice(index + 1)
        if (lines.length === messages.length) {
          socket.end()
          resolve(lines)
          return
        }
      }
    })
    socket.on('error', reject)
  })
}

test('formal remote project port delegates to the official API', async () => {
  const sourceAgent = { id: 'controller', session: { header: { cwd: '/srv' } } }
  let captured
  const port = createRemoteProjectPort({
    hostId: 'remote-host',
    sourceAllowlist: [{ sourceHostId: 'local-host', sourceSessionId: 'controller', controllerSessionId: 'controller' }],
    api: { async openProject(args, exec) { captured = { args, exec }; return { ok: true, workspace_id: 'w', session_id: 's', workspace: { path: args.path } } } },
    ctx: { agents: { get(id) { return id === 'controller' ? sourceAgent : undefined } } },
  })
  const response = await port.openProject({ hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'controller', request: { absolutePath: '/srv/project', idempotencyKey: 'project-key-001', desiredState: { defaultPermission: 'workspace-write' } } })
  assert.equal(response.type, 'remote-project.result')
  assert.equal(response.result.sessionId, 's')
  assert.equal(captured.args.idempotency_key, 'project-key-001')
  assert.equal(captured.exec.agent, sourceAgent)
})

test('remote project bridge delegates to official API and preserves source identity', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-session-remote-'))
  const socketPath = path.join(root, 'remote-project.sock')
  const sourceAgent = { id: 'controller', session: { header: { cwd: root } } }
  let captured
  const api = {
    async openProject(args, exec) {
      captured = { args, exec }
      return { ok: true, workspace_id: 'workspace-1', session_id: 'session-1', workspace: { path: args.path }, operation: { operation_id: 'operation-1' } }
    },
    async createSchedule(args) {
      return { ok: true, schedule: { id: args.idempotency_key } }
    },
  }
  const ctx = { agents: { get(id) { return id === 'controller' ? sourceAgent : undefined } } }
  const bridge = await startRemoteProjectBridge({ api, ctx, hostId: 'remote-host', sourceAllowlist: [{ sourceHostId: 'local-host', sourceSessionId: 'controller', controllerSessionId: 'controller' }], socketPath })
  try {
    const [pong, result] = await request(socketPath, [
      { type: 'remote-project.ping', hostId: 'remote-host' },
      {
        type: 'remote-project.open',
        hostId: 'remote-host',
        sourceHostId: 'local-host',
        sourceSessionId: 'controller',
        operationId: 'operation-1',
        request: {
          absolutePath: root,
          idempotencyKey: 'project-key-001',
          desiredState: { defaultPermission: 'workspace-write' },
          schedule: { prompt: 'check', after_seconds: 60 },
        },
      },
    ])
    assert.equal(pong.type, 'remote-project.pong')
    assert.equal(result.type, 'remote-project.result')
    assert.equal(result.result.workspaceId, 'workspace-1')
    assert.equal(result.result.sessionId, 'session-1')
    assert.equal(captured.args.idempotency_key, 'project-key-001')
    assert.equal(captured.args.permission_preset, 'workspace-write')
    assert.equal(captured.exec.agent, sourceAgent)
  } finally {
    await bridge.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('formal runtime auth binds source capability and exact nonce before any target Session exists', async () => {
  const sourceAgent = { id: 'controller', session: { header: { cwd: '/srv/controller' } } }
  const port = createRemoteProjectPort({
    hostId: 'remote-host',
    sourceAllowlist: [{ sourceHostId: 'local-host', sourceSessionId: 'controller', controllerSessionId: 'controller' }],
    api: { async openProject() { throw new Error('not used') } },
    ctx: { agents: { get(id) { return id === 'controller' ? sourceAgent : undefined } } },
  })
  const request = { runtimeId: 'codex', version: '1.0.0', sha256: 'a'.repeat(64), challengeId: 'challenge-000000000000', nonce: 'nonce_abcdefghijklmnopqrstuvwxyz012345', expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const begun = await port.beginRuntimeAuth({ hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'controller', request })
  assert.equal(begun.result.accepted, true)
  await assert.rejects(port.confirmRuntimeAuth({ hostId: 'remote-host', sourceHostId: 'forged-host', sourceSessionId: 'controller', request }), /nonce is unknown|authorized/)
  const confirmed = await port.confirmRuntimeAuth({ hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'controller', request })
  assert.deepEqual(confirmed.result, { approved: true, targetSessionId: null })
})

test('formal execution policy is derived from the real target Session after project creation', async () => {
  const sourceAgent = { id: 'controller', session: { header: { cwd: '/srv/controller' } } }
  const targetAgent = { id: 'target-session', status: 'idle', session: { header: { cwd: '/srv/project' }, events: [] } }
  const port = createRemoteProjectPort({
    hostId: 'remote-host',
    sourceAllowlist: [{ sourceHostId: 'local-host', sourceSessionId: 'controller', controllerSessionId: 'controller' }],
    api: { async openProject() { throw new Error('not used') } },
    ctx: {
      agents: { get(id) { return id === 'controller' ? sourceAgent : id === 'target-session' ? targetAgent : undefined } },
      permissionPresets: { current() { return 'workspace-write' } },
    },
  })
  const policy = await port.verifyTargetSessionPolicy({ hostId: 'remote-host', sourceHostId: 'local-host', sourceSessionId: 'controller', targetSessionId: 'target-session', request: {} })
  assert.equal(policy.result.verified, true)
  assert.equal(policy.result.targetSessionId, 'target-session')
  assert.equal(policy.result.workspaceRoot, '/srv/project')
  await assert.rejects(port.verifyTargetSessionPolicy({ hostId: 'remote-host', sourceHostId: 'forged-host', sourceSessionId: 'controller', targetSessionId: 'target-session', request: {} }), /authorized/)
})
