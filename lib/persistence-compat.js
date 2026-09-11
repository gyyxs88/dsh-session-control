/** Read a stored session without acquiring write ownership; always release the handle. */
export async function inspectSession(persistence, id) {
  if (typeof persistence.open !== 'function') return persistence.inspect(id)
  let handle
  try {
    handle = await persistence.open(id, 'read')
    const { events } = await handle.read()
    return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
  } catch (error) {
    if (error?.name === 'SessionPersistenceNotFoundError') return undefined
    throw error
  } finally {
    await handle?.close()
  }
}

/** DSH 0.1.5 lists snapshots rather than bare headers. */
export async function listSessionHeaders(persistence, signal) {
  const modern = typeof persistence.open === 'function'
  const rows = await persistence.list(modern ? { signal } : signal)
  return rows.map(row => modern ? row.header : row)
}
