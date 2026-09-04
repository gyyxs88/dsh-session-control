/**
 * Return a detached snapshot of one Session's committed events.
 *
 * DSH 0.1.2 removed the public mutable `session.events` array in favour of
 * `snapshotEvents()`.  The fallback keeps this plugin usable on the already
 * supported 0.1.0/0.1.1 line and by its lightweight test doubles, while every
 * real 0.1.2 Session uses the new immutable snapshot API.
 */
export function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') return session.snapshotEvents()
  return Array.isArray(session?.events) ? [...session.events] : []
}
