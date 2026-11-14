// Small, deterministic line diff for version history. It is presentation data, never authority.
export const lineDiff = (before = '', after = '') => {
  const oldLines = String(before).split('\n'); const newLines = String(after).split('\n');
  return newLines.map(line => oldLines.includes(line) ? { kind: 'same', line } : { kind: 'added', line })
    .concat(oldLines.filter(line => !newLines.includes(line)).map(line => ({ kind: 'removed', line })));
};
