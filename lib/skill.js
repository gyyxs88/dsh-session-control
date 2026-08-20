import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const BUNDLED_SKILL_URL = new URL(
  '../skills/dsh-session-control/SKILL.md',
  import.meta.url,
)

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, 'mu'))
  if (match === null) throw new Error(`bundled skill is missing ${key}`)
  const value = match[1].trim()
  if (value.length === 0) throw new Error(`bundled skill has an empty ${key}`)
  return value
}

export function parseBundledSkill(source, skillPath = fileURLToPath(BUNDLED_SKILL_URL)) {
  const normalized = String(source).replaceAll('\r\n', '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]+)$/u)
  if (match === null) throw new Error('bundled skill requires YAML frontmatter and a body')
  const name = frontmatterValue(match[1], 'name')
  const description = frontmatterValue(match[1], 'description')
  const content = match[2].trim()
  if (content.length === 0) throw new Error('bundled skill has an empty body')
  return {
    name,
    description,
    content,
    source: 'bundled',
    provider: 'dsh-session-control',
    path: skillPath,
    resourceBase: {
      kind: 'directory',
      path: path.dirname(skillPath),
    },
    invocation: {
      modelInvocable: true,
      userInvocable: true,
    },
  }
}

export async function loadBundledSkill() {
  return parseBundledSkill(
    await readFile(BUNDLED_SKILL_URL, 'utf8'),
    fileURLToPath(BUNDLED_SKILL_URL),
  )
}

export async function registerBundledSkill(ctx) {
  return ctx.skills.register(await loadBundledSkill())
}
