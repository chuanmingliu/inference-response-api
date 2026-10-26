// Only snapshots created here qualify for reuse. A frozen client array alone
// is not trusted. Weak keys release content when the socket evicts its history.
const snapshots = new WeakMap();

export function immutableCopy(value) {
  const copy = structuredClone(value);
  const pending = [copy];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== 'object' || Object.isFrozen(item)) continue;
    Object.freeze(item);
    for (const child of Object.values(item)) if (child && typeof child === 'object') pending.push(child);
  }
  return copy;
}

export function historyBytes(history) {
  return snapshots.get(history)?.bytes ?? Buffer.byteLength(JSON.stringify(history));
}

export function snapshotHistory(history) {
  return snapshots.has(history) ? history : appendHistory([], history);
}

export function appendHistory(history, items) {
  const prefix = snapshots.has(history) ? history : immutableCopy(history);
  const delta = immutableCopy(items);
  const result = Object.freeze([...prefix, ...delta]);
  // JSON array delimiters and commas are exact even for empty arrays, Unicode
  // and escaped strings. Only new Items need to be serialized on continuation.
  const bytes = historyBytes(prefix) + Buffer.byteLength(JSON.stringify(delta)) - 2
    + (prefix.length && delta.length ? 1 : 0);
  snapshots.set(result, { bytes });
  return result;
}
