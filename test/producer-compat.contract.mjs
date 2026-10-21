import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { controlMessageSource } from '../lib/security.js'

test('official Session admits canonical producers in pending/consumed slots and restores fsynced snapshots', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'producer-compat-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const session = Session.create('producer-compat')
  for (const form of ['relay', 'permission-change', 'approval-notice', 'operation-terminal-report', 'operation-attention-report']) {
    const message = createUserMessage({ source: controlMessageSource(form), content: [{ type: 'text', text: form }] })
    session.append('agent/inbox/spliced', { target: 'next-turn', inserted: [message], deleted: [] })
    session.append('user/message', message, { surfaceOp: 'append' })
  }
  const header = session.header
  const rows = session.snapshotEvents()
  const file = path.join(root, 'canonical.jsonl')
  const writer = await open(file, 'wx')
  try {
    await writer.writeFile([header, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n')
    await writer.sync()
  } finally { await writer.close() }
  const [diskHeader, ...diskRows] = (await readFile(file, 'utf8')).trim().split('\n').map(s => JSON.parse(s))
  const restored = Session.create(diskHeader.id, diskRows, diskHeader)
  assert.deepEqual(restored.snapshotEvents().slice(0, rows.length), rows)
  assert.equal(restored.snapshotEvents().filter(e => e.type === 'user/message').length, 5)
})
