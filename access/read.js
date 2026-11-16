// Scope records deliberately contain no item text. Callers obtain this small record
// before retrieving events, artifacts, or derived bodies.
export const defaultCanRead = (viewer, item) => {
  if (!viewer || !item) return false;
  if (!Array.isArray(item.audience) || item.audience.length === 0) return true;
  const id = typeof viewer === 'string' ? viewer : viewer.id;
  return typeof id === 'string' && Array.isArray(item.members) && item.members.includes(id);
};

export function canRead(viewer, item, policy = defaultCanRead) {
  return policy(viewer, item) === true;
}

// Content may travel from a source case into a target case's audience only if everyone who can read the target
// can also read the source. An unrestricted source covers anyone; an unrestricted target (everyone) is covered
// only by an unrestricted source. This is the audience-intersection rule that reanalysis, annexes, open-thread
// comments and digests all rely on.
export function audienceCovers(sourceScope, targetScope) {
  if (!sourceScope || !targetScope) return false;
  if (!Array.isArray(sourceScope.audience) || sourceScope.audience.length === 0) return true;
  if (!Array.isArray(targetScope.audience) || targetScope.audience.length === 0) return false;
  const allowed = new Set(sourceScope.members || []);
  return (targetScope.members || []).every(person => allowed.has(person));
}
