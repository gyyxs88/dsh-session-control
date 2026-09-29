import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { currentSessionMessageProjections } from '@deepseek-ai/dsh-session-format-catalog/message-projections'

/** Ask DSH's own permission projection for a cold session's effective preset. */
export function storedPermissionPreset(ctx, inspection) {
  const session = Session.fromRestore(
    SessionId(inspection.meta.id),
    inspection.events,
    inspection.meta,
    SessionLogOffset(inspection.inheritedEventCount ?? 0),
    'detached',
    currentSessionMessageProjections,
  )
  return ctx.permissionPresets.current(session)
}
