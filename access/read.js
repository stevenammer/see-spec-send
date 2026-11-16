export const defaultCanRead = (viewer, item) => true;

export function canRead(viewer, item, policy = defaultCanRead) {
  return policy(viewer, item) === true;
}
