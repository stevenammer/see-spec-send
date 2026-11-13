import { DatabaseSync } from 'node:sqlite';

export function dumpGolden(file) {
  if (!file) throw new Error('usage: node scripts/dump-golden.mjs DATABASE');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const dump = db.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map(row => row.sql.endsWith(';') ? row.sql : `${row.sql};`).join('\n');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const literal = value => value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
  const rows = tables.flatMap(({ name }) => {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${quoted})`).all().map(column => column.name);
    return db.prepare(`SELECT * FROM ${quoted}`).all().map(row =>
      `INSERT INTO ${quoted}(${columns.map(column => `"${column.replaceAll('"', '""')}"`).join(',')}) VALUES(${columns.map(column => literal(row[column])).join(',')});`);
  }).join('\n');
    return `-- Golden SQLite dump, PRAGMA user_version=${version}.\nPRAGMA user_version=${version};\n${dump}\n${rows}\n`;
  } finally { db.close(); }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  process.stdout.write(dumpGolden(process.argv[2]));
}
