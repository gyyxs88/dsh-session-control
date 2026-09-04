import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionEvents } from '../lib/session-events.js'

test('reads DSH 0.1.2 immutable Session snapshots without touching the removed events property', () => {
  let reads = 0
  const session = {
    snapshotEvents() {
      reads += 1
      return Object.freeze([{ seq: 1, type: 'turn/end', data: { turn: 0 } }])
    },
    get events() {
      throw new Error('legacy events property must not be read')
    },
  }

  assert.deepEqual(sessionEvents(session), [{ seq: 1, type: 'turn/end', data: { turn: 0 } }])
  assert.equal(reads, 1)
})

test('keeps the supported legacy Session and lightweight test-double path detached', () => {
  const legacy = { events: [{ seq: 2, type: 'turn/end', data: { turn: 1 } }] }
  const snapshot = sessionEvents(legacy)
  snapshot.push({ seq: 3, type: 'turn/start', data: { turn: 2 } })
  assert.equal(legacy.events.length, 1)
  assert.deepEqual(sessionEvents(undefined), [])
})
