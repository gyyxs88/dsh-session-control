const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const APPROVAL_KINDS = new Set(['command', 'file-change', 'permissions'])
const CLAUDE_APPROVAL_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'Task', 'Skill', 'Computer'])
const MAX_APPROVAL_TIMEOUT_MS = 120_000

function policyError(message, code = 'EXECUTION_POLICY_UNVERIFIED') {
  const error = new Error(message)
  error.code = code
  throw error
}

function sessionFor(ctx, id, label) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) policyError(`${label} identity is invalid`)
  const agent = ctx.agents.get(id)
  if (agent === undefined) policyError(`${label} is not a live Session`)
  const status = agent.status ?? agent.session?.status
  if (typeof status === 'string' && ['closed', 'stopped', 'terminated', 'disposed'].includes(status)) policyError(`${label} is not active`)
  if (agent.session?.header?.origin === 'subagent') policyError(`${label} cannot be a subagent`)
  return agent
}

function currentPermission(ctx, agent) {
  if (typeof ctx.permissionPresets?.current !== 'function') policyError('official permission snapshot service is unavailable', 'EXECUTION_POLICY_SERVICE_UNAVAILABLE')
  const permission = ctx.permissionPresets.current(agent.session?.events ?? [])
  if (!PERMISSIONS.has(permission)) policyError('target Session permission preset is unsupported')
  return permission
}

function boundedCallId(value) {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[^A-Za-z0-9._:-]/gu, '').slice(0, 128)
  return normalized.length > 0 ? normalized : undefined
}

function boundedPermissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { fileSystem: null, network: null }
  const result = { fileSystem: null, network: null }
  for (const key of ['fileSystem', 'network']) {
    const candidate = value[key]
    if (candidate === null || candidate === undefined) continue
    try {
      const encoded = JSON.stringify(candidate)
      if (typeof encoded !== 'string' || encoded.length > 4096) continue
      const parsed = JSON.parse(encoded)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        result[key] = parsed
      }
    } catch {}
  }
  return result
}

function denyCodex(kind) {
  return kind === 'permissions'
    ? { codexResponse: { permissions: { fileSystem: null, network: null }, scope: 'turn' } }
    : { approved: false }
}

function boundedProtocolName(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.replace(/[^A-Za-z0-9._:/-]/gu, '').slice(0, 96)
  return normalized.length > 0 ? normalized : fallback
}

function acpPermissionResponse(params, allowed) {
  const options = Array.isArray(params?.options) ? params.options.filter((option) => option && typeof option === 'object' && typeof option.optionId === 'string' && option.optionId.length > 0 && typeof option.kind === 'string') : []
  const preferredKinds = allowed ? ['allow_once'] : ['reject_once', 'deny_once', 'reject']
  const selected = options.find((option) => preferredKinds.includes(option.kind))
  if (!selected) throw new Error('ACP permission request has no supported one-time option')
  return { outcome: { outcome: 'selected', optionId: selected.optionId } }
}

function createTargetSessionApprovalHandler(ctx, target, { timeoutMs = 30_000, signal } = {}) {
  if (typeof ctx.approval?.request !== 'function') return undefined
  const boundedTimeoutMs = Math.max(100, Math.min(MAX_APPROVAL_TIMEOUT_MS, Number(timeoutMs) || 30_000))
  const requestTarget = async ({ toolName, callId, kind }) => {
    if (signal?.aborted) return false
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener?.('abort', abort, { once: true })
    const timeoutMarker = Symbol('approval-timeout')
    const timer = setTimeout(() => {
      controller.abort()
    }, boundedTimeoutMs)
    timer.unref?.()
    let raceTimer
    try {
      const outcome = await Promise.race([
        ctx.approval.request({
          agent: target,
          toolName,
          ...(callId === undefined ? {} : { callId }),
          reason: `One-time ${kind} approval requested in the target Session`,
          signal: controller.signal,
        }),
        new Promise((resolve) => {
          raceTimer = setTimeout(() => resolve(timeoutMarker), boundedTimeoutMs)
        }),
      ])
      if (outcome === timeoutMarker) return false
      return outcome === 'allowed-once'
    } catch {
      return false
    } finally {
      clearTimeout(timer)
      clearTimeout(raceTimer)
      signal?.removeEventListener?.('abort', abort)
    }
  }
  return async (request = {}) => {
    const { channel, kind, method, requestId, params, toolName, toolUseID, options: acpOptions } = request
    const callId = boundedCallId(requestId ?? toolUseID)
    if (channel === 'codex' && APPROVAL_KINDS.has(kind) && (method === `item/${kind === 'command' ? 'commandExecution' : kind === 'file-change' ? 'fileChange' : 'permissions'}/requestApproval`)) {
      const allowed = await requestTarget({ toolName: `coding-agent/codex/${kind}`, callId, kind: `Codex ${kind}` })
      return allowed && kind === 'permissions'
        ? { codexResponse: { permissions: boundedPermissions(params?.permissions), scope: 'turn' } }
        : allowed ? { approved: true } : denyCodex(kind)
    }
    if (channel === 'claude-code' && typeof toolName === 'string' && CLAUDE_APPROVAL_TOOLS.has(toolName)) {
      const allowed = await requestTarget({ toolName: `coding-agent/claude/${toolName}`, callId, kind: `Claude ${toolName}` })
      return allowed ? { behavior: 'allow' } : { behavior: 'deny', message: 'target-session approval was not granted' }
    }
    if (channel === 'acp' && method === 'session/request_permission') {
      const allowed = await requestTarget({ toolName: 'coding-agent/acp/session-request-permission', callId, kind: 'ACP permission' })
      return acpPermissionResponse({ options: acpOptions ?? params?.options }, allowed)
    }
    throw new Error('unsupported or malformed channel approval request')
  }
}

export function createSessionControlExecutionPolicyServices({ ctx, controllerSessionIds = [], approvalTimeoutMs = 30_000 } = {}) {
  if (!ctx?.agents?.get) throw new Error('execution policy service requires the official agents service')
  const controllers = new Set(controllerSessionIds)
  const resolve = async ({ exec } = {}) => {
    const agent = exec?.agent
    if (!agent?.id) policyError('execution policy requires a live DSH Session')
    const target = sessionFor(ctx, agent.id, 'target Session')
    const permission = currentPermission(ctx, target)
    const workspaceRoot = target.session?.header?.cwd ?? target.session?.meta?.cwd
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) policyError('target Session workspace root is unavailable', 'EXECUTION_POLICY_SERVICE_UNAVAILABLE')
    return {
      permission,
      approvalOwner: permission === 'danger-full-access' ? 'full-access-controller' : 'target-session',
      approvalMode: permission === 'danger-full-access' ? 'controller-verified' : 'target-session',
      workspaceRoot,
      sourceSessionId: target.id,
      targetSessionId: target.id,
      ...(permission === 'workspace-write'
        ? { approvalHandler: createTargetSessionApprovalHandler(ctx, target, { timeoutMs: approvalTimeoutMs, signal: exec?.signal }) }
        : {}),
    }
  }
  const verifier = {
    async verifyTargetSessionPolicy({ exec, policy } = {}) {
      const target = sessionFor(ctx, policy?.targetSessionId, 'target Session')
      if (exec?.agent?.id !== target.id) policyError('execution policy target does not match the invoking Session', 'EXECUTION_POLICY_SESSION_MISMATCH')
      const source = sessionFor(ctx, policy?.sourceSessionId, 'source Session')
      if (source.id !== target.id && (controllers.size === 0 || !controllers.has(source.id))) policyError('execution policy source is not an authorized controller', 'EXECUTION_POLICY_SOURCE_UNAUTHORIZED')
      const permission = currentPermission(ctx, target)
      const workspaceRoot = target.session?.header?.cwd ?? target.session?.meta?.cwd
      if (permission !== policy.permission || workspaceRoot !== policy.workspaceRoot) policyError('execution policy changed before channel launch', 'EXECUTION_POLICY_STALE')
      return {
        verified: true,
        authority: 'dsh-session-control',
        permission,
        workspaceRoot,
        sourceSessionId: source.id,
        targetSessionId: target.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }
    },
  }
  return Object.freeze({ resolver: resolve, verifier })
}
