import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const task = path.resolve(process.argv[2] ?? '../../temp/full-access-control-20260930')
const sdk = path.resolve(process.argv[3] ?? path.join(task, 'sdk'))
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24 required')
fs.mkdirSync(task, { recursive: true })
const run = fs.mkdtempSync(path.join(task, 'tests-'))
const fixtures = path.join(run, 'fixtures')
fs.mkdirSync(fixtures)
const env = {
  TMP: fixtures, TEMP: fixtures, TMPDIR: fixtures,
  SESSION_CONTROL_TEST_TASK: task, SESSION_CONTROL_TEST_TMP: fixtures, SESSION_CONTROL_TEST_SDK: sdk,
  USERPROFILE: fixtures, APPDATA: fixtures, LOCALAPPDATA: fixtures,
}
if (process.platform === 'win32') Object.assign(env, { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' })
const files = fs.readdirSync(path.join(repo, 'test')).filter(f => f.endsWith('.test.js')).sort().map(f => 'test/' + f)
const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(repo, 'scripts/official-test-runtime.mjs')).href,
  '--test', '--test-isolation=none', ...files], { cwd: repo, env, encoding: 'utf8', windowsHide: true })
fs.writeFileSync(path.join(run, 'stdout.log'), result.stdout ?? '')
fs.writeFileSync(path.join(run, 'stderr.log'), result.stderr ?? '')
const summary = { node: process.versions.node, exitCode: result.status, files: files.length,
  inheritedEnvironment: false, cleanup: 'recoverable rename', sdk, run }
fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(summary, null, 2) + '\n')
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
console.log(JSON.stringify(summary))
process.exitCode = result.status ?? 1
