// Small, deterministic line diff for version history. It is presentation data, never authority.
export const lineDiff = (before = '', after = '') => {
  if (before === '' && after === '') return [];
  const oldLines = String(before).split('\n'); const newLines = String(after).split('\n');
  const lengths = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));
  for (let oldAt = oldLines.length - 1; oldAt >= 0; oldAt -= 1) for (let newAt = newLines.length - 1; newAt >= 0; newAt -= 1) {
    lengths[oldAt][newAt] = oldLines[oldAt] === newLines[newAt]
      ? lengths[oldAt + 1][newAt + 1] + 1
      : Math.max(lengths[oldAt + 1][newAt], lengths[oldAt][newAt + 1]);
  }
  const result = []; let oldAt = 0; let newAt = 0;
  while (oldAt < oldLines.length || newAt < newLines.length) {
    if (oldAt < oldLines.length && newAt < newLines.length && oldLines[oldAt] === newLines[newAt]) { result.push({ kind: 'same', line: oldLines[oldAt] }); oldAt += 1; newAt += 1; }
    else if (newAt < newLines.length && (oldAt === oldLines.length || lengths[oldAt][newAt + 1] > lengths[oldAt + 1][newAt])) { result.push({ kind: 'added', line: newLines[newAt] }); newAt += 1; }
    else { result.push({ kind: 'removed', line: oldLines[oldAt] }); oldAt += 1; }
  }
  return result;
};
