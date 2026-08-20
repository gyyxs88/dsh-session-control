import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BUNDLED_SKILL_URL,
  loadBundledSkill,
  parseBundledSkill,
  registerBundledSkill,
} from '../lib/skill.js'

test('bundled skill is a complete model and user invocable DSH skill', async () => {
  const skill = await loadBundledSkill()
  assert.equal(skill.name, 'dsh-session-control')
  assert.match(skill.description, /会话/u)
  assert.equal(skill.source, 'bundled')
  assert.equal(skill.provider, 'dsh-session-control')
  assert.deepEqual(skill.invocation, {
    modelInvocable: true,
    userInvocable: true,
  })
  assert.equal(skill.path, fileURLToPath(BUNDLED_SKILL_URL))
  assert.equal(skill.resourceBase.path, path.dirname(skill.path))
  for (const required of [
    'session_status',
    'session_project_open',
    'session_send',
    'session_wait',
    'session_schedule_create',
    'session_permission_set',
    'session_approval_decide',
    'session_operations',
  ]) {
    assert.match(skill.content, new RegExp(required, 'u'))
  }
})

test('bundled skill parser fails closed on an incomplete skill', () => {
  assert.throws(
    () => parseBundledSkill('---\nname: incomplete\n---\nbody'),
    /missing description/u,
  )
  assert.throws(
    () => parseBundledSkill('---\nname: incomplete\ndescription: test\n---\n'),
    /frontmatter and a body/u,
  )
})

test('bundled skill registers through the native DSH skill registry', async () => {
  let registered
  const disposer = () => {}
  const result = await registerBundledSkill({
    skills: {
      register(skill) {
        registered = skill
        return disposer
      },
    },
  })
  assert.equal(registered.name, 'dsh-session-control')
  assert.equal(result, disposer)
})
