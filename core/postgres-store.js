import { DatabaseSync } from 'node:sqlite';
import { Store } from './store.js';

// Store's public methods are synchronous. A production Postgres deployment
// therefore supplies a reviewed synchronous compatibility driver here, rather
// than this module quietly opening a network connection. The driver owns its
// pool, TLS settings, migrations, and transaction mapping, and exposes only
// the DatabaseSync-shaped surface Store needs: exec(sql), prepare(sql), close().
export class PostgresStore extends Store {
  constructor({ database, driver }) {
    if (!database) throw new Error('Postgres database configuration required');
    if (!driver || typeof driver.open !== 'function') {
      throw new Error('Postgres compatibility driver required');
    }
    super('', { database: driver.open(database), kind: 'postgres' });
  }
}

// This is intentionally an in-process behavioral fake, not a Postgres
// emulator. It lets the same Store contract run without a server or network.
// It must never be selected by application configuration.
export class FakePostgresStore extends Store {
  constructor() {
    super(':memory:', { database: new DatabaseSync(':memory:'), kind: 'postgres-fake' });
  }
}

