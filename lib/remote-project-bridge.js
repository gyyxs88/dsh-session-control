import { chmod, lstat, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { getRemoteProjectManifest } from './remote-manifest.js'

const MAX_FRAME_BYTES = 128 * 1024
const MAX_PENDING_FRAMES = 64

function validateSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || !path.posix.isAbsolute(socketPath) || socketPath.includes('..') || /[\0\r\n]/u.test(socketPath)) {
    throw new Error('remoteProjectSocket 必须是无 traversal 的绝对 POSIX socket 路径')
  }
  return socketPath
}

function safeProjectResult(value) {
  return {
    projectId: value.project_id ?? null,
    workspaceId: value.workspace_id ?? null,
    sessionId: value.session_id ?? null,
    workspacePath: value.workspace?.path ?? null,
    permissionPreset: value.permission_pending === true ? 'pending' : null,
    scheduleState: value.schedule ?? null,
    state: value.ok === true ? 'completed' : value.partial === true ? 'partial' : 'failed',
    operation: value.operation ?? null,
    permissionOperation: value.permission_operation ?? null,
  }
}

export function createRemoteProjectPort({ api, ctx, hostId, logger = console } = {}) {
  if (!api?.openProject || !ctx?.agents?.get) throw new Error('remote project port requires the official session-control api and agents service')
  if (!hostId) throw new Error('remote project port hostId is required')
  return {
    hostId,
    async ping(request) {
      if (request.hostId !== hostId) throw new Error('remote project host identity mismatch')
      return { type: 'remote-project.pong', hostId, protocolVersion: '1.0', manifest: getRemoteProjectManifest() }
    },
    async openProject(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      if (!frame.sourceHostId || !frame.sourceSessionId) throw new Error('remote project source identity is required')
      const sourceAgent = ctx.agents.get(frame.sourceSessionId)
      if (sourceAgent === undefined) throw new Error('remote project source controller is not live')
      const request = frame.request ?? {}
      const result = await api.openProject({
        path: request.absolutePath,
        title: request.displayName,
        idempotency_key: request.idempotencyKey,
        permission_preset: request.desiredState?.defaultPermission,
        create_directory: true,
      }, { agent: sourceAgent })
      if (request.schedule && result.session_id) {
        try {
          if (typeof api.createSchedule !== 'function') throw new Error('official session-control schedule API is unavailable')
          result.schedule = await api.createSchedule({
            target_id: result.session_id,
            prompt: request.schedule.prompt,
            after_seconds: request.schedule.after_seconds,
            at: request.schedule.at,
            every_seconds: request.schedule.every_seconds,
            idempotency_key: `${request.idempotencyKey}:schedule`,
          }, { agent: sourceAgent })
        } catch (error) {
          result.partial = true
          result.schedule = { status: 'needs-attention', error: { code: error.code ?? 'SCHEDULE_UNKNOWN', message: String(error.message ?? error) } }
        }
      }
      return { type: 'remote-project.result', result: safeProjectResult(result) }
    },
    async close() {},
    logger,
  }
}

export async function startRemoteProjectBridge({ api, ctx, hostId, socketPath, logger = console } = {}) {
  const safeSocketPath = validateSocketPath(socketPath)
  const port = createRemoteProjectPort({ api, ctx, hostId, logger })
  try {
    const info = await lstat(safeSocketPath)
    if (info.isSocket()) await unlink(safeSocketPath)
    else throw new Error('remote project socket path is occupied by a non-socket')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const server = net.createServer((socket) => {
    let buffer = ''
    let processing = Promise.resolve()
    let pending = 0
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer += chunk
      if (!buffer.includes('\n') && Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        socket.destroy(new Error('remote project frame exceeds limit'))
        return
      }
      while (true) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
          socket.destroy(new Error('remote project frame exceeds limit'))
          return
        }
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch (error) {
          socket.write(`${JSON.stringify({ type: 'error', error: { code: 'REMOTE_PROJECT_INVALID_JSON', message: error.message } })}\n`)
          continue
        }
        if (pending >= MAX_PENDING_FRAMES) {
          socket.write(`${JSON.stringify({ type: 'error', error: { code: 'REMOTE_PROJECT_PENDING_LIMIT', message: 'too many queued remote project requests' } })}\n`)
          continue
        }
        pending += 1
        processing = processing.then(async () => {
          try {
            const response = frame.type === 'remote-project.ping'
              ? await port.ping(frame)
              : frame.type === 'remote-project.open'
                ? await port.openProject(frame)
                : (() => { throw new Error('unsupported remote project bridge request') })()
            socket.write(`${JSON.stringify(response)}\n`)
          } catch (error) {
            socket.write(`${JSON.stringify({ type: 'error', error: { code: error.code ?? 'REMOTE_PROJECT_ERROR', message: String(error.message ?? error) } })}\n`)
          }
        }).catch((error) => logger.warn?.(`remote project bridge frame failed: ${String(error)}`)).finally(() => { pending -= 1 })
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(safeSocketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await chmod(safeSocketPath, 0o600)
  return {
    socketPath: safeSocketPath,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()))
      await unlink(safeSocketPath).catch(() => {})
    },
  }
}
