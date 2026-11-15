// A scope is a list of resource/audience identifiers approved with the spec.
// Prose cannot grant a resource. Runtime builders still have no network access.
export const emptyScope = () => ({ data_sources: [], audiences: [] });
export function validScope(scope) {
  return scope && typeof scope === 'object' && !Array.isArray(scope)
    && Object.keys(scope).sort().join(',') === 'audiences,data_sources'
    && ['data_sources', 'audiences'].every(key => Array.isArray(scope[key]) && scope[key].length <= 20
      && scope[key].every(value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 120)
      && new Set(scope[key]).size === scope[key].length);
}
export function withinScope(approved, requested) {
  return validScope(approved) && validScope(requested)
    && ['data_sources', 'audiences'].every(key => requested[key].every(value => approved[key].includes(value)));
}
