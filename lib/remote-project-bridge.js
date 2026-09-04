import { chmod, lstat, unlink } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { getRemoteProjectManifest } from './remote-manifest.js'
import { sessionEvents } from './session-events.js'

const MAX_FRAME_BYTES = 128 * 1024
const MAX_PENDING_FRAMES = 64
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const RUNTIME_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u
const SHA256 = /^[a-f0-9]{64}$/u

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

export function createRemoteProjectPort({ api, ctx, hostId, sourceAllowlist = [], logger = console } = {}) {
  if (!api?.openProject || !ctx?.agents?.get) throw new Error('remote project port requires the official session-control api and agents service')
  if (!hostId) throw new Error('remote project port hostId is required')
  const authorizedSources = new Map(sourceAllowlist.map((value) => [`${value?.sourceHostId}\u0000${value?.sourceSessionId}`, value]))
  const runtimeAuthChallenges = new Map()

  const agentFor = (id, label) => {
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new Error(`${label} is invalid`)
    const agent = ctx.agents.get(id)
    if (agent === undefined) throw new Error(`${label} is unknown on this Host`)
    const sessionHostId = agent.session?.header?.hostId ?? agent.session?.meta?.hostId ?? agent.hostId
    if (sessionHostId !== undefined && sessionHostId !== hostId) throw new Error(`${label} is not owned by this Host`)
    if (agent.session?.header?.origin === 'subagent') throw new Error(`${label} cannot be a subagent`)
    const status = agent.status ?? agent.session?.status
    if (typeof status === 'string' && ['closed', 'stopped', 'terminated', 'disposed'].includes(status)) throw new Error(`${label} is not active`)
    return agent
  }

  const sourceFor = (frame) => {
    if (typeof frame.sourceHostId !== 'string' || frame.sourceHostId.length === 0) throw new Error('remote project source host identity is required')
    if (typeof frame.sourceSessionId !== 'string' || !SESSION_ID.test(frame.sourceSessionId)) throw new Error('source Session identity is invalid')
    const capability = authorizedSources.get(`${frame.sourceHostId}\u0000${frame.sourceSessionId}`)
    if (!capability || typeof capability.controllerSessionId !== 'string' || !SESSION_ID.test(capability.controllerSessionId)) {
      const error = new Error('source controller capability is not authorized for this Host')
      error.code = 'REMOTE_PROJECT_SOURCE_NOT_REGISTERED'
      error.details = { sourceHostId: frame.sourceHostId, sourceSessionId: frame.sourceSessionId, needsAttention: true }
      throw error
    }
    const controller = agentFor(capability.controllerSessionId, 'configured controller Session')
    return { sourceHostId: frame.sourceHostId, sourceSessionId: frame.sourceSessionId, controller }
  }

  const targetFor = (frame) => agentFor(frame.targetSessionId, 'target Session')

  const permissionFor = (agent, label) => {
    if (typeof ctx.permissionPresets?.current !== 'function') throw new Error('official permission snapshot service is unavailable')
    const preset = ctx.permissionPresets.current(sessionEvents(agent.session))
    if (!PERMISSIONS.has(preset)) throw new Error(`${label} has no supported permission preset`)
    return preset
  }

  const validateRuntimeRequest = (request) => {
    if (!request || typeof request !== 'object' || !RUNTIME_ID.test(request.runtimeId ?? '') || typeof request.version !== 'string' || request.version.length === 0 || !SHA256.test(request.sha256 ?? '')) throw new Error('runtime auth request identity is invalid')
    return { runtimeId: request.runtimeId, version: request.version, sha256: request.sha256 }
  }

  const validateNonce = (nonce) => {
    if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/u.test(nonce)) throw new Error('runtime auth nonce is invalid')
    return nonce
  }

  return {
    hostId,
    async ping(request) {
      if (request.hostId !== hostId) throw new Error('remote project host identity mismatch')
      return { type: 'remote-project.pong', hostId, protocolVersion: '1.0', manifest: getRemoteProjectManifest() }
    },
    async openProject(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      if (!frame.sourceHostId || !frame.sourceSessionId) throw new Error('remote project source identity is required')
      const source = sourceFor(frame)
      const sourceAgent = source.controller
      const request = frame.request ?? {}
      const signal = AbortSignal.timeout(60_000)
      const result = await api.openProject({
        path: request.absolutePath,
        title: request.displayName,
        idempotency_key: request.idempotencyKey,
        permission_preset: request.desiredState?.defaultPermission,
        create_directory: true,
      }, { agent: sourceAgent, signal })
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
          }, { agent: sourceAgent, signal })
        } catch (error) {
          result.partial = true
          result.schedule = { status: 'needs-attention', error: { code: error.code ?? 'SCHEDULE_UNKNOWN', message: String(error.message ?? error) } }
        }
      }
      return { type: 'remote-project.result', result: safeProjectResult(result) }
    },
    async deleteSchedule(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      const source = sourceFor(frame)
      if (typeof api.deleteSchedule !== 'function') throw new Error('official session-control schedule delete API is unavailable')
      const targetSessionId = String(frame.targetSessionId ?? '')
      const scheduleId = String(frame.request?.scheduleId ?? '').trim()
      const idempotencyKey = String(frame.request?.idempotencyKey ?? '').trim()
      if (!SESSION_ID.test(targetSessionId)) throw new Error('schedule target Session identity is invalid')
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scheduleId)) throw new Error('schedule identity is invalid')
      if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new Error('schedule delete idempotency key is invalid')
      const result = await api.deleteSchedule({
        target_id: targetSessionId,
        schedule_id: scheduleId,
        idempotency_key: idempotencyKey,
      }, { agent: source.controller, signal: AbortSignal.timeout(60_000) })
      return { type: 'remote-project.schedule-delete-result', result }
    },
    async createSchedule(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      const source = sourceFor(frame)
      if (typeof api.createSchedule !== 'function') throw new Error('official session-control schedule API is unavailable')
      const targetSessionId = String(frame.targetSessionId ?? '')
      const request = frame.request ?? {}
      const prompt = String(request.prompt ?? '').trim()
      const idempotencyKey = String(request.idempotencyKey ?? '').trim()
      if (!SESSION_ID.test(targetSessionId)) throw new Error('schedule target Session identity is invalid')
      if (prompt.length < 1 || prompt.length > 12_000) throw new Error('schedule prompt is invalid')
      if (idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new Error('schedule create idempotency key is invalid')
      const timing = [request.afterSeconds !== undefined, request.at !== undefined, request.everySeconds !== undefined].filter(Boolean).length
      if (timing !== 1) throw new Error('schedule create requires exactly one timing mode')
      if (request.afterSeconds !== undefined && (!Number.isSafeInteger(request.afterSeconds) || request.afterSeconds < 1)) throw new Error('schedule afterSeconds is invalid')
      if (request.everySeconds !== undefined && (!Number.isSafeInteger(request.everySeconds) || request.everySeconds < 300)) throw new Error('schedule everySeconds is invalid')
      if (request.at !== undefined && (typeof request.at !== 'string' || request.at.length < 1 || request.at.length > 128)) throw new Error('schedule at is invalid')
      const result = await api.createSchedule({
        target_id: targetSessionId,
        prompt,
        after_seconds: request.afterSeconds,
        at: request.at,
        every_seconds: request.everySeconds,
        idempotency_key: idempotencyKey,
      }, { agent: source.controller, signal: AbortSignal.timeout(60_000) })
      return { type: 'remote-project.schedule-create-result', result }
    },
    async beginRuntimeAuth(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      const source = sourceFor(frame)
      const request = validateRuntimeRequest(frame.request)
      const nonce = validateNonce(frame.request.nonce)
      const expiresAt = Date.parse(frame.request.expiresAt)
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 15 * 60_000) throw new Error('runtime auth challenge expiry is invalid')
      const challengeId = String(frame.request.challengeId ?? '')
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(challengeId)) throw new Error('runtime auth challenge id is invalid')
      runtimeAuthChallenges.set(nonce, {
        challengeId,
        nonce,
        ...request,
        ...source,
        targetHostId: hostId,
        targetSessionId: frame.targetSessionId ?? null,
        expiresAt: new Date(expiresAt).toISOString(),
      })
      return { type: 'remote-project.runtime-auth-begin-result', result: { accepted: true, targetSessionId: frame.targetSessionId ?? null } }
    },
    async confirmRuntimeAuth(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      const request = validateRuntimeRequest(frame.request)
      const nonce = validateNonce(frame.request.nonce)
      const challenge = runtimeAuthChallenges.get(nonce)
      if (!challenge || challenge.challengeId !== frame.request.challengeId || challenge.sourceHostId !== frame.sourceHostId || challenge.sourceSessionId !== frame.sourceSessionId || (challenge.targetSessionId !== null && challenge.targetSessionId !== frame.request.targetSessionId) || challenge.runtimeId !== request.runtimeId || challenge.version !== request.version || challenge.sha256 !== request.sha256 || Date.parse(challenge.expiresAt) <= Date.now()) throw new Error('runtime auth nonce is unknown, expired, or bound to another controller or runtime')
      runtimeAuthChallenges.delete(nonce)
      return { type: 'remote-project.runtime-auth-result', result: { approved: true, targetSessionId: challenge.targetSessionId } }
    },
    async verifyTargetSessionPolicy(frame) {
      if (frame.hostId !== hostId) throw new Error('remote project host identity mismatch')
      const source = sourceFor(frame)
      const target = targetFor(frame)
      const permission = permissionFor(target, 'target Session')
      const workspaceRoot = target.session?.header?.cwd ?? target.session?.meta?.cwd
      if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) throw new Error('target Session workspace root is unavailable')
      const requestedPermission = frame.request?.permission
      const ranks = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
      if (requestedPermission !== undefined && (!Object.hasOwn(ranks, requestedPermission) || ranks[requestedPermission] > ranks[permission])) throw new Error('requested execution policy exceeds target Session')
      const effectivePermission = requestedPermission ?? permission
      if (frame.request?.workspaceRoot !== undefined && frame.request.workspaceRoot !== workspaceRoot) throw new Error('requested workspace root does not match target Session')
      const expiresAt = new Date(Date.now() + 60_000).toISOString()
      return {
        type: 'remote-project.execution-policy-result',
        result: {
          verified: true,
          authority: 'dsh-session-control',
          permission: effectivePermission,
          workspaceRoot,
          sourceSessionId: source.sourceSessionId,
          targetSessionId: target.id,
          expiresAt,
        },
      }
    },
    async close() {},
    logger,
  }
}

export async function startRemoteProjectBridge({ api, ctx, hostId, socketPath, sourceAllowlist, logger = console } = {}) {
  const safeSocketPath = validateSocketPath(socketPath)
  const port = createRemoteProjectPort({ api, ctx, hostId, sourceAllowlist, logger })
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
                : frame.type === 'remote-project.schedule-create'
                  ? await port.createSchedule(frame)
                  : frame.type === 'remote-project.schedule-delete'
                    ? await port.deleteSchedule(frame)
                : frame.type === 'remote-project.runtime-auth-begin'
                  ? await port.beginRuntimeAuth(frame)
                  : frame.type === 'remote-project.runtime-auth-confirm'
                    ? await port.confirmRuntimeAuth(frame)
                    : frame.type === 'remote-project.execution-policy-verify'
                      ? await port.verifyTargetSessionPolicy(frame)
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
