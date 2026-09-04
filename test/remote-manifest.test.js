import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import packageJson from '../package.json' with { type: 'json' }
import { getRemoteProjectManifest, validateRemoteProjectManifest } from '../lib/remote-manifest.js'

test('remote manifest is machine-readable, versioned, and advertises the supported single-host bridge', async () => {
  const manifest = validateRemoteProjectManifest(packageJson.dsh.remote)
  assert.equal(manifest.pluginId, 'dsh-session-control')
  assert.equal(manifest.version, '0.8.0')
  assert.deepEqual(manifest.placements, ['remote'])
  assert.deepEqual(manifest.dshCompatibility, { min: '0.1.0-rc.6', max: '0.1.2-rc.1' })
  assert.ok(manifest.capabilities.includes('session-control.port'))
  assert.ok(manifest.capabilities.includes('remote-project.schedule-create'))
  assert.equal(manifest.bundledSkills[0].id, 'dsh-session-control')
  assert.equal(manifest.bundledSkills[0].version, '0.8.0')
  const skill = await readFile(new URL('../skills/dsh-session-control/SKILL.md', import.meta.url))
  assert.equal(manifest.bundledSkills[0].sha256, createHash('sha256').update(skill).digest('hex'))
  assert.equal(getRemoteProjectManifest().protocolVersion, '1.0')
})

test('remote manifest rejects missing placement or bundled Skill digest', () => {
  const manifest = getRemoteProjectManifest()
  assert.throws(() => validateRemoteProjectManifest({ ...manifest, placements: ['both'] }))
  assert.throws(() => validateRemoteProjectManifest({ ...manifest, bundledSkills: [{ ...manifest.bundledSkills[0], sha256: 'missing' }] }))
})
