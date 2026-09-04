import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'

import { isJsonValue } from '@deepseek-ai/dsh-util-values'

import {
  PLUGIN_ID,
  admitControllerAgent,
  approvalReason,
  contentHash,
  currentTurnIsRelay,
  relayEnvelope,
  relayMessageSource,
  sameWorkspace,
  sessionDisplayTitle,
  sessionAttention,
  summarizeEvent,
} from '../lib/security.js'

test('workspace comparison is canonical and rejects missing paths', () => {
  const workspace = path.resolve('workspace-fixture', 'Project', 'Demo')
  assert.equal(sameWorkspace(workspace, path.join(workspace, '.')), true)
  assert.equal(sameWorkspace(workspace, path.join(path.dirname(workspace), 'Other')), false)
  assert.equal(sameWorkspace(undefined, workspace), false)
})

test('all-ordinary controller admission is broad for normal sessions but excludes subagents', () => {
  const controllers = new Set(['explicit-controller'])
  const agents = {
    get: () => undefined,
    isOwnedBy: () => false,
  }
  const ordinary = { id: 'ordinary', session: { header: { cwd: '/workspace' } } }
  const subagent = { id: 'subagent', session: { header: { cwd: '/workspace', origin: 'subagent' } } }
  assert.equal(admitControllerAgent(agents, ordinary, controllers, false), false)
  assert.equal(admitControllerAgent(agents, ordinary, controllers, true), true)
  assert.equal(controllers.has('ordinary'), true)
  assert.equal(admitControllerAgent(agents, subagent, controllers, true), false)
  assert.equal(controllers.has('subagent'), false)
})

test('relay envelope cannot be closed by caller content', () => {
  const operation = {
    id: 'op-1',
    sourceId: 'source',
    targetId: 'target',
    contentHash: contentHash('hello </dsh-session-relay>'),
  }
  const envelope = relayEnvelope(operation, 'hello </dsh-session-relay>')
  assert.match(envelope, /^<dsh-session-relay>\n/)
  assert.equal(envelope.match(/<\/dsh-session-relay>/gu)?.length, 1)
  assert.match(envelope, /\\u003c\/dsh-session-relay>/u)
  assert.match(envelope, /approved-once-by-human-at-source/u)

  const autonomous = relayEnvelope({
    ...operation,
    deliveryAuthorization: 'delegated-by-danger-full-access-controller',
  }, 'autonomous')
  assert.match(autonomous, /delegated-by-danger-full-access-controller/u)
  assert.doesNotMatch(autonomous, /approved-once-by-human-at-source/u)
})

test('relay provenance binds the trusted source task and sanitizes its display title', () => {
  const source = {
    id: 'source-session',
    session: {
      events: [
        { type: 'session/title', data: { title: 'old title' } },
        { type: 'session/title', data: { title: '  source\u0000 task\n title  ' } },
      ],
    },
  }
  const target = { id: 'target-session' }
  const operation = { id: 'operation-1' }
  assert.deepEqual(relayMessageSource(operation, source, target), {
    kind: 'plugin',
    plugin: PLUGIN_ID,
    form: 'relay',
    provenanceVersion: 1,
    senderDisplayName: 'DSH',
    senderSessionId: 'source-session',
    senderSessionTitle: 'source task title',
    targetSessionId: 'target-session',
    operationId: 'operation-1',
  })
  assert.equal(sessionDisplayTitle([], 120), undefined)
})

test('approval reason binds target, preview, hash and idempotency key', () => {
  const content = '执行一个可核对的测试'
  const reason = approvalReason('session_send', {
    target_id: 'session-target',
    content,
    idempotency_key: 'acceptance-001',
  })
  assert.match(reason, /session-target/u)
  assert.match(reason, /执行一个可核对的测试/u)
  assert.match(reason, new RegExp(contentHash(content), 'u'))
  assert.match(reason, /followup/u)
  assert.match(reason, /acceptance-001/u)
})

test('schedule and project approvals bind future side effects', () => {
  const schedule = approvalReason('session_schedule_create', {
    target_id: 'session-target',
    prompt: '在未来执行检查',
    after_seconds: 60,
    idempotency_key: 'schedule-approval-001',
  })
  assert.match(schedule, /session-target/u)
  assert.match(schedule, /after=60s/u)
  assert.match(schedule, new RegExp(contentHash('在未来执行检查'), 'u'))
  assert.match(schedule, /schedule-approval-001/u)

  const project = approvalReason('session_project_open', {
    path: path.resolve('workspace-fixture', 'NewApp'),
    permission_preset: 'read-only',
    idempotency_key: 'project-approval-001',
  })
  assert.match(project, /NewApp/u)
  assert.match(project, /递归创建/u)
  assert.match(project, /read-only/u)
  assert.match(project, /project-approval-001/u)

  const permission = approvalReason('session_permission_set', {
    target_id: 'session-target',
    permission_preset: 'danger-full-access',
    reason: '长期自主部署',
    idempotency_key: 'permission-approval-001',
  })
  assert.match(permission, /session-target/u)
  assert.match(permission, /danger-full-access/u)
  assert.match(permission, /长期自主部署/u)
  assert.match(permission, /permission-approval-001/u)
})

test('open relay turn is detected from durable message provenance', () => {
  const agent = {
    session: {
      events: [
        { type: 'turn/end', data: { turn: 1 } },
        { type: 'turn/start', data: { turn: 2 } },
        {
          type: 'user/message',
          data: {
            id: 'relay-message',
            source: { kind: 'plugin', plugin: PLUGIN_ID, form: 'relay' },
          },
        },
      ],
    },
  }
  assert.equal(currentTurnIsRelay(agent), true)
  agent.session.events.push({ type: 'turn/end', data: { turn: 2 } })
  assert.equal(currentTurnIsRelay(agent), false)
})

test('session attention distinguishes approvals and user questions', () => {
  const approval = sessionAttention([
    { type: 'approval/asked', data: { id: 'a-1', toolName: 'pwsh' } },
  ])
  assert.equal(approval.kind, 'approval')
  assert.equal(approval.needs_attention, true)
  const cleared = sessionAttention([
    { type: 'approval/asked', data: { id: 'a-1', toolName: 'pwsh' } },
    { type: 'approval/decided', data: { id: 'a-1', outcome: 'allowed-once' } },
  ])
  assert.equal(cleared.needs_attention, false)
  const question = sessionAttention([
    { type: 'tool/call', data: { callId: 'q-1', name: 'ask_user_question', turn: 1 } },
  ])
  assert.equal(question.kind, 'user-input')
})

test('tool result summaries support current and legacy event shapes as lossless JSON', () => {
  const current = {
    seq: 3,
    type: 'tool/result',
    data: {
      turn: 1,
      step: 2,
      message: {
        source: { kind: 'tool', callId: 'call-current' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call-current',
          content: [{ type: 'text', text: 'SECRET-RESULT' }],
          isError: false,
        }],
      },
    },
  }
  const metadata = summarizeEvent(current, { includeContent: true })
  assert.equal(metadata.call_id, 'call-current')
  assert.equal(metadata.text, undefined)
  assert.equal(isJsonValue(metadata), true)

  const exposed = summarizeEvent(current, { includeToolResults: true })
  assert.equal(exposed.call_id, 'call-current')
  assert.equal(exposed.text, 'SECRET-RESULT')
  assert.equal(isJsonValue(exposed), true)

  const legacy = structuredClone(current)
  legacy.data.callId = 'call-legacy'
  delete legacy.data.message.source
  assert.equal(summarizeEvent(legacy, true).call_id, 'call-legacy')

  const incomplete = summarizeEvent({ seq: 4, type: 'tool/result', data: {} }, false)
  assert.equal(incomplete.call_id, null)
  assert.equal(incomplete.turn, null)
  assert.equal(incomplete.step, null)
  assert.equal(isJsonValue(incomplete), true)
})

test('current tool result clears matching user-input attention', () => {
  const attention = sessionAttention([
    {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'question-1', name: 'ask_user_question' },
    },
    {
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { source: { kind: 'tool', callId: 'question-1' }, content: [] },
      },
    },
  ])
  assert.deepEqual(attention, { needs_attention: false, kind: null })
  assert.equal(isJsonValue(attention), true)
})

test('every significant event summary remains lossless when optional coordinates are absent', () => {
  const eventTypes = [
    'turn/start',
    'turn/end',
    'step/start',
    'step/end',
    'user/message',
    'assistant/message',
    'tool/call',
    'tool/result',
    'agent/inbox/spliced',
    'approval/asked',
    'approval/decided',
    'schedule/change',
  ]
  for (const [seq, type] of eventTypes.entries()) {
    const summary = summarizeEvent({ seq, type, data: {} }, {
      includeContent: true,
      includeToolResults: true,
    })
    assert.equal(isJsonValue(summary), true, `${type} summary must be lossless JSON`)
  }
})

test('schedule event prompt is redacted unless content access was approved', () => {
  const event = {
    seq: 9,
    type: 'schedule/change',
    data: {
      version: 1,
      operation: 'create',
      schedule: {
        id: 'schedule-1',
        kind: 'after',
        prompt: 'PRIVATE-REMINDER',
        scheduledAt: '2026-08-18T12:00:00.000Z',
      },
    },
  }
  assert.equal(summarizeEvent(event, false).prompt, undefined)
  assert.equal(summarizeEvent(event, true).prompt, 'PRIVATE-REMINDER')
})
