import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectSession, listSessionHeaders } from '../lib/persistence-compat.js'

test('handle persistence closes reads on both success and failure', async () => {
  let closes = 0
  const header = { id: 'fixture' }
  const handle = { header, inheritedEventCount: 2, read: async () => ({ events: [1] }), close: async () => { closes++ } }
  const persistence = { open: async (id, access) => { assert.equal(id, 'fixture'); assert.equal(access, 'read'); return handle } }
  assert.deepEqual(await inspectSession(persistence, 'fixture'), { meta: header, inheritedEventCount: 2, events: [1] })
  handle.read = async () => { throw Error('read failed') }
  await assert.rejects(inspectSession(persistence, 'fixture'), /read failed/)
  assert.equal(closes, 2)
})

test('snapshot listing forwards cancellation and unwraps headers', async () => {
  const signal = new AbortController().signal
  const header = { id: 'fixture' }
  assert.deepEqual(await listSessionHeaders({ open() {}, list: async options => {
    assert.equal(options.signal, signal); return [{ header, revision: 'opaque' }]
  } }, signal), [header])
})

test('missing sessions return undefined while other open errors propagate', async () => {
  const error = new Error('missing'); error.name = 'SessionPersistenceNotFoundError'
  const persistence = { open: async () => { throw error } }
  assert.equal(await inspectSession(persistence, 'missing'), undefined)
  error.name = 'StorageError'
  await assert.rejects(inspectSession(persistence, 'missing'), /missing/)
})

test('legacy persistence retains inspect and list argument contracts', async () => {
  const signal = new AbortController().signal
  const result = { meta: { id: 'old' }, events: [] }
  const persistence = { inspect: async id => { assert.equal(id, 'old'); return result }, list: async input => { assert.equal(input, signal); return [result.meta] } }
  assert.equal(await inspectSession(persistence, 'old'), result)
  assert.deepEqual(await listSessionHeaders(persistence, signal), [result.meta])
})
