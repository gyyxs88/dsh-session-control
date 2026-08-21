import { readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const files = (await readdir('test')).filter((name) => name.endsWith('.test.js')).sort().map((name) => `test/${name}`)
const major = Number(process.versions.node.split('.')[0])
if (!Number.isSafeInteger(major) || major < 24) {
  console.error(`dsh-session-control tests require Node.js >=24; current runtime is ${process.version}`)
  process.exit(1)
}
const child = spawn(process.execPath, ['--test', '--test-isolation=none', ...files], { stdio: 'inherit', windowsHide: true })
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
