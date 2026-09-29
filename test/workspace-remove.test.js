import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { makeApi } from '../lib/index.js'
import { OperationStore } from '../lib/state-store.js'

const root = os.tmpdir()
const stateDir = path.join(root, `main-test-state-${Date.now()}`)
const projectDir = path.join(stateDir, 'project')
await mkdir(projectDir, { recursive: true })
const keepFile = path.join(projectDir, 'keep.txt')
await writeFile(keepFile, 'session-file-stays\n', 'utf8')
const originalHash = createHash('sha256').update(await readFile(keepFile)).digest('hex')

const controller = { id: 'controller', session: { header: { cwd: projectDir }, events: [] } }
const outsider = { id: 'outsider', session: { header: { cwd: projectDir }, events: [] } }
const entries = new Map([
  ['workspace-1', { id: 'workspace-1', path: projectDir, title: 'Project' }],
  ['workspace-2', { id: 'workspace-2', path: path.join(stateDir, 'other'), title: 'Other' }],
])
let deleteCalls = 0
const ctx = {
  workspaceRegistry: {
    get: id => entries.get(id),
    async delete(id) { deleteCalls++; return entries.delete(id) },
  },
}
const store = await new OperationStore({ stateDir: path.join(stateDir, 'operations') }).load()
const api = makeApi(ctx, {}, store, new Set(['controller']))
const exec = { agent: controller }
const args = { workspace_id: 'workspace-1', expected_path: projectDir, idempotency_key: 'remove-main-001' }

await assert.rejects(api.removeWorkspace(args, { agent: outsider }), /控制权限/u)
await assert.rejects(api.removeWorkspace({ ...args, expected_path: path.join(stateDir, 'wrong') }, exec), /不匹配/u)
await assert.rejects(api.removeWorkspace({ ...args, workspace_id: 'unknown' }, exec), /未登记/u)
assert.equal(deleteCalls, 0)

const first = await api.removeWorkspace(args, exec)
assert.equal(first.ok, true)
assert.equal(first.workspace_removed, true)
assert.equal(first.operation.status, 'completed')
assert.equal(entries.has('workspace-1'), false)
assert.equal(entries.has('workspace-2'), true)
assert.equal(createHash('sha256').update(await readFile(keepFile)).digest('hex'), originalHash)
const again = await api.removeWorkspace(args, exec)
assert.equal(again.ok, true)
assert.equal(again.duplicate, true)
assert.equal(deleteCalls, 1)
await assert.rejects(api.removeWorkspace({ ...args, workspace_id: 'workspace-2' }, exec), /幂等键/u)

entries.set('workspace-3', { id: 'workspace-3', path: projectDir, title: 'Again' })
const recoverArgs = { ...args, workspace_id: 'workspace-3', idempotency_key: 'remove-main-002' }
const originalUpdate = store.update.bind(store)
let failCompletedWrite = true
store.update = async (id, patch) => {
  if (failCompletedWrite && patch.status === 'completed') {
    failCompletedWrite = false
    throw Error('simulated receipt write failure')
  }
  return originalUpdate(id, patch)
}
const partial = await api.removeWorkspace(recoverArgs, exec)
assert.equal(partial.ok, false)
assert.equal(partial.partial, true)
assert.equal(entries.has('workspace-3'), false)
const recovered = await api.removeWorkspace(recoverArgs, exec)
assert.equal(recovered.ok, true)
assert.equal(recovered.duplicate, true)
assert.equal(recovered.workspace_removed, false)
assert.equal(recovered.operation.status, 'completed')
assert.equal(createHash('sha256').update(await readFile(keepFile)).digest('hex'), originalHash)

await store.dispose()
const reloaded = await new OperationStore({ stateDir: path.join(stateDir, 'operations') }).load()
assert.equal(reloaded.findByIdempotency('controller', args.idempotency_key)?.status, 'completed')
assert.equal(reloaded.findByIdempotency('controller', recoverArgs.idempotency_key)?.status, 'completed')
await reloaded.dispose()
console.log(JSON.stringify({ status: 'passed', checks: 16, deleteCalls,
  directoryPreserved: true, fileHash: originalHash, stateDir }))
