const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const API_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u

export const REMOTE_PROJECT_MANIFEST = Object.freeze({
  manifestVersion: '1.0',
  pluginId: 'dsh-session-control',
  version: '0.6.7',
  placements: Object.freeze(['remote']),
  protocolVersion: '1.0',
  apiVersion: '1.0',
  dshCompatibility: Object.freeze({ min: '0.1.0-rc.6', max: '0.1.1-rc.2' }),
  capabilities: Object.freeze([
    'session-control.port',
    'schedule.port',
    'remote-project.open',
    'remote-project.schedule-create',
    'remote-project.schedule-delete',
    'remote-project.runtime-auth-begin',
    'remote-project.runtime-auth-confirm',
    'remote-project.execution-policy-verify',
  ]),
  bundledSkills: Object.freeze([Object.freeze({
    id: 'dsh-session-control',
    version: '0.6.1',
    sha256: 'a83173dd2913b98ef83566db05a0a5cafa0d5c15727955ec0cbb8d22f82b5d0d',
  })]),
})

export function getRemoteProjectManifest() {
  return structuredClone(REMOTE_PROJECT_MANIFEST)
}

export function validateRemoteProjectManifest(manifest = REMOTE_PROJECT_MANIFEST) {
  if (!manifest || manifest.manifestVersion !== '1.0' || manifest.pluginId !== 'dsh-session-control' || !SEMVER.test(manifest.version ?? '') || manifest.protocolVersion !== '1.0' || !API_VERSION.test(manifest.apiVersion ?? '')) {
    throw new Error('remote project manifest is invalid')
  }
  if (!Array.isArray(manifest.placements) || manifest.placements.length !== 1 || manifest.placements[0] !== 'remote') throw new Error('remote project placement is invalid')
  if (!manifest.dshCompatibility || !SEMVER.test(manifest.dshCompatibility.min ?? '') || !SEMVER.test(manifest.dshCompatibility.max ?? '')) throw new Error('remote project DSH compatibility is invalid')
  if (!Array.isArray(manifest.capabilities) || ['session-control.port', 'remote-project.open', 'remote-project.schedule-create', 'remote-project.schedule-delete', 'remote-project.runtime-auth-begin', 'remote-project.runtime-auth-confirm', 'remote-project.execution-policy-verify'].some((capability) => !manifest.capabilities.includes(capability))) throw new Error('remote project capabilities are invalid')
  if (!Array.isArray(manifest.bundledSkills) || manifest.bundledSkills.some((skill) => !skill || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(skill.id ?? '') || !SEMVER.test(skill.version ?? '') || !/^[a-f0-9]{64}$/u.test(skill.sha256 ?? ''))) throw new Error('bundled Skill manifest is invalid')
  return structuredClone(manifest)
}
