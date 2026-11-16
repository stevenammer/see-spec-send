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
