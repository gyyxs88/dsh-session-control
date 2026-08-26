import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionControlExecutionPolicyServices } from '../lib/execution-policy-service.js'

function makeContext(request) {
  const target = { id: 'target-child', status: 'idle', session: { header: { cwd: '/srv/project' }, events: [] } }
  const calls = []
  const ctx = {
    agents: { get(id) { return id === target.id ? target : undefined } },
    permissionPresets: { current() { return 'workspace-write' } },
    approval: { request: async (value) => { calls.push(value); return request(value) } },
  }
  return { target, calls, ctx }
}

test('formal target approval adapter converts Codex, Claude and ACP requests to target Session once-only approval', async () => {
  const { target, calls, ctx } = makeContext(async () => 'allowed-once')
  const { resolver } = createSessionControlExecutionPolicyServices({ ctx, approvalTimeoutMs: 1000 })
  const policy = await resolver({ exec: { agent: target } })
  const codex = await policy.approvalHandler({
    channel: 'codex',
    kind: 'command',
    method: 'item/commandExecution/requestApproval',
    requestId: 7,
    params: { command: 'hidden from approval reason' },
  })
  assert.deepEqual(codex, { approved: true })
  const claude = await policy.approvalHandler({ channel: 'claude-code', toolName: 'Write', toolUseID: 'tool-1', input: { secret: 'not forwarded' } })
  assert.deepEqual(claude, { behavior: 'allow' })
  const acp = await policy.approvalHandler({
    channel: 'acp',
    method: 'session/request_permission',
    params: { options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] },
  })
  assert.deepEqual(acp, { outcome: { outcome: 'selected', optionId: 'allow' } })
  assert.equal(calls.length, 3)
  assert.ok(calls.every((call) => call.agent === target))
  assert.ok(calls.every((call) => !String(call.reason).includes('secret')))
  await assert.rejects(policy.approvalHandler({ channel: 'unknown', method: 'approval', kind: 'command' }), /unsupported or malformed/)
  await assert.rejects(policy.approvalHandler({ channel: 'acp', method: 'other', params: {} }), /unsupported or malformed/)
})

test('formal target approval adapter denies rejected/expired requests and never guesses a protocol response', async () => {
  const { target, ctx } = makeContext(async () => 'rejected')
  const { resolver } = createSessionControlExecutionPolicyServices({ ctx, approvalTimeoutMs: 100 })
  const policy = await resolver({ exec: { agent: target } })
  assert.deepEqual(await policy.approvalHandler({ channel: 'codex', kind: 'command', method: 'item/commandExecution/requestApproval' }), { approved: false })
  assert.deepEqual(await policy.approvalHandler({ channel: 'claude-code', toolName: 'Bash', toolUseID: 't' }), { behavior: 'deny', message: 'target-session approval was not granted' })
  await assert.rejects(policy.approvalHandler({ channel: 'acp', method: 'session/request_permission', params: { options: [{ optionId: 'always', kind: 'allow_always' }] } }), /no supported one-time option/)
  const timeout = makeContext(() => new Promise(() => {}))
  const timeoutServices = createSessionControlExecutionPolicyServices({ ctx: timeout.ctx, approvalTimeoutMs: 100 })
  const timeoutPolicy = await timeoutServices.resolver({ exec: { agent: timeout.target } })
  const started = Date.now()
  const denied = await timeoutPolicy.approvalHandler({ channel: 'claude-code', toolName: 'Edit', toolUseID: 'timeout' })
  assert.deepEqual(denied, { behavior: 'deny', message: 'target-session approval was not granted' })
  assert.ok(Date.now() - started >= 90)
})

test('read-only and Full Access policies do not expose a manual approval callback', async () => {
  const target = { id: 'target-child', status: 'idle', session: { header: { cwd: '/srv/project' }, events: [] } }
  const ctx = { agents: { get(id) { return id === target.id ? target : undefined } }, permissionPresets: { current() { return 'read-only' } }, approval: { request: async () => 'allowed-once' } }
  const { resolver } = createSessionControlExecutionPolicyServices({ ctx })
  const readOnly = await resolver({ exec: { agent: target } })
  assert.equal(readOnly.approvalHandler, undefined)
  ctx.permissionPresets.current = () => 'danger-full-access'
  const full = await resolver({ exec: { agent: target } })
  assert.equal(full.approvalHandler, undefined)
})

test('a child run may safely downgrade target permission but never elevate it', async () => {
  const { target, ctx } = makeContext(async () => 'allowed-once')
  const { resolver, verifier } = createSessionControlExecutionPolicyServices({ ctx })
  const downgraded = await resolver({ exec: { agent: target }, request: { executionPermission: 'read-only' } })
  assert.equal(downgraded.permission, 'read-only')
  assert.equal(downgraded.approvalHandler, undefined)
  const verified = await verifier.verifyTargetSessionPolicy({ exec: { agent: target }, policy: downgraded })
  assert.equal(verified.permission, 'read-only')

  ctx.permissionPresets.current = () => 'read-only'
  await assert.rejects(
    resolver({ exec: { agent: target }, request: { executionPermission: 'workspace-write' } }),
    (error) => error?.code === 'EXECUTION_POLICY_ELEVATION_REQUIRED',
  )
  await assert.rejects(
    verifier.verifyTargetSessionPolicy({ exec: { agent: target }, policy: { ...downgraded, permission: 'workspace-write' } }),
    (error) => error?.code === 'EXECUTION_POLICY_ELEVATION_REQUIRED',
  )
})
