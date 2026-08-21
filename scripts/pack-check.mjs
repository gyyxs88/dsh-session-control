import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmCli = process.env.npm_execpath || join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js')
function runNpm(args) {
  if (process.platform === 'win32' && existsSync(npmCli)) return spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (process.platform === 'win32') return spawnSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return spawnSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const root = await mkdtemp(join(tmpdir(), 'dsh-session-pack-'))
try {
  const pack = runNpm(['pack', '--pack-destination', root])
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr ?? pack.error?.message ?? 'unknown error'}`)
  const tgz = (await readdir(root)).find((name) => name.endsWith('.tgz'))
  if (!tgz) throw new Error('npm pack produced no tgz')
  const consumer = join(root, 'consumer')
  const install = runNpm(['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--offline', '--prefix', consumer, join(root, tgz)])
  if (install.status !== 0) throw new Error(`packed tgz install failed: ${install.stderr ?? install.error?.message ?? 'unknown error'}`)
  const packageRoot = join(consumer, 'node_modules', 'dsh-session-control')
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  if (manifest.dsh?.remote?.pluginId !== 'dsh-session-control' || manifest.dsh.remote.placements?.[0] !== 'remote' || !manifest.dsh.remote.capabilities?.includes('remote-project.schedule-create')) throw new Error('packed remote manifest smoke failed')
  const entry = pathToFileURL(join(packageRoot, 'lib', 'remote-manifest.js')).href
  const imported = spawnSync(process.execPath, ['-e', `const m=await import(${JSON.stringify(entry)}); if(m.getRemoteProjectManifest().pluginId!=='dsh-session-control') process.exit(2)`], { encoding: 'utf8', stdio: 'pipe' })
  if (imported.status !== 0) throw new Error(`packed manifest import smoke failed: ${imported.stderr}`)
  console.log(JSON.stringify({ status: 'passed', tarball: tgz, imported: true, remoteManifest: true }))
} finally {
  await rm(root, { recursive: true, force: true })
}
