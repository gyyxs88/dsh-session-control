// Test only: unchanged official SDK bytes and recoverable generated fixtures.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const task = path.resolve(process.env.SESSION_CONTROL_TEST_TASK ?? '')
const fixtures = path.resolve(process.env.SESSION_CONTROL_TEST_TMP ?? '')
const sdk = path.resolve(process.env.SESSION_CONTROL_TEST_SDK ?? '')
if (!process.env.SESSION_CONTROL_TEST_TMP || !fixtures.startsWith(task + path.sep)
  || fs.lstatSync(fixtures).isSymbolicLink()) throw new Error('Dedicated hermetic runner required')
const manifest = JSON.parse(fs.readFileSync(path.join(sdk, 'manifest.json'), 'utf8'))
if (manifest.formatVersion !== 1 || !['0.2.0-rc.2', '0.2.0-rc.1'].includes(manifest.source.version)) throw new Error('Unreviewed SDK')
const packages = new Map()
let count = 0
for (const pkg of manifest.packages) {
  const dir = path.join(sdk, 'node_modules', pkg.name)
  for (const file of pkg.files) {
    const full = path.resolve(dir, file.path)
    if (!full.startsWith(dir + path.sep)) throw new Error('SDK path escape')
    const bytes = fs.readFileSync(full)
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('SDK integrity failure')
    count++
  }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  if (meta.name !== pkg.name || meta.version !== pkg.version) throw new Error('SDK identity failure')
  packages.set(pkg.name, { dir, meta })
}
registerHooks({ resolve(specifier, context, next) {
  const parts = specifier.split('/')
  const scoped = specifier.startsWith('@')
  const name = parts.slice(0, scoped ? 2 : 1).join('/')
  const pkg = packages.get(name)
  if (name.startsWith('@deepseek-ai/') && !pkg) throw new Error('Official test SDK lacks ' + name)
  if (!pkg) return next(specifier, context)
  const sub = parts.slice(scoped ? 2 : 1).join('/')
  const key = sub ? './' + sub : '.'
  const declared = typeof pkg.meta.exports === 'string' ? (key === '.' ? pkg.meta.exports : undefined) : pkg.meta.exports?.[key]
  const entry = typeof declared === 'string' ? declared : declared?.import?.default ?? declared?.import ?? declared?.default ?? (key === '.' ? pkg.meta.main : undefined)
  if (typeof entry !== 'string') throw new Error('Unsupported SDK export ' + specifier)
  const target = path.resolve(pkg.dir, entry)
  if (!target.startsWith(pkg.dir + path.sep)) throw new Error('SDK export path escape')
  return { url: pathToFileURL(target).href, shortCircuit: true }
} })
const recovery = path.join(path.dirname(fixtures), 'recovery', String(process.pid))
fs.mkdirSync(recovery, { recursive: true })
const moves = []
const rename = fs.renameSync.bind(fs)
const preserve = (input, options = {}) => {
  const absolute = path.resolve(input instanceof URL ? fileURLToPath(input) : String(input))
  if (!absolute.startsWith(fixtures + path.sep)) throw new Error('Refusing cleanup outside generated fixtures')
  if (!fs.existsSync(absolute)) {
    if (options.force) return
    throw Object.assign(new Error('fixture absent'), { code: 'ENOENT' })
  }
  const parent = fs.realpathSync(path.dirname(absolute))
  if (parent !== fixtures && !parent.startsWith(fixtures + path.sep)) throw new Error('Fixture parent escaped')
  const backup = path.join(recovery, String(moves.length))
  rename(absolute, backup)
  moves.push({ original: absolute, backup })
  fs.writeFileSync(path.join(recovery, 'moves.json'), JSON.stringify(moves, null, 2) + '\n')
}
fs.rmSync = preserve
fs.unlinkSync = preserve
fs.promises.rm = async (...args) => preserve(...args)
fs.promises.unlink = async (...args) => preserve(...args)
syncBuiltinESMExports()
console.log(`OFFICIAL_TEST_SDK_VERIFIED version=${manifest.source.version} packages=${packages.size} files=${count}; fixtures use recoverable rename`)
