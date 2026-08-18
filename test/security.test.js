import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLUGIN_ID,
  approvalReason,
  contentHash,
  currentTurnIsRelay,
  relayEnvelope,
  sameWorkspace,
} from '../lib/security.js'

test('workspace comparison is canonical and rejects missing paths', () => {
  assert.equal(sameWorkspace('D:\\Project\\Demo', 'd:\\project\\demo\\.'), true)
  assert.equal(sameWorkspace('D:\\Project\\Demo', 'D:\\Project\\Other'), false)
  assert.equal(sameWorkspace(undefined, 'D:\\Project\\Demo'), false)
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
  assert.match(reason, /acceptance-001/u)
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
