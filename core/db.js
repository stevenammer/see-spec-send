// One async door to the database. Every method returns a promise, so code written against it keeps working
// when the database is on the other side of a network (see docs/POSTGRES_PLAN.md). This is the SQLite
// implementation: it wraps the synchronous node:sqlite calls on the connection the Store already owns.
//
// Transactions: tx(work) hands `work` its own scoped handle. Calls made on the door itself while a transaction
// is open wait until it commits or rolls back, so another request's statements can never land inside it. That
// is the same shape a networked database gives you (a client per transaction). One caveat until the Store
// itself is converted: code that still uses the connection directly, outside this door, is not held back, so a
// transaction's work should not wait on real I/O (a timer, a network call) yet.

class Scoped {
  #db;
  constructor(db) { this.#db = db; }
  async get(sql, ...params) { return this.#db.prepare(sql).get(...params); }
  async all(sql, ...params) { return this.#db.prepare(sql).all(...params); }
  async run(sql, ...params) {
    const result = this.#db.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }
  async exec(sql) { this.#db.exec(sql); }
  async tx() { throw new Error('transactions do not nest'); }
}

export class SqliteDb extends Scoped {
  #raw;
  #active = null;

  constructor(database) {
    if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') throw new Error('a SQLite connection is required');
    super(database);
    this.#raw = database;
  }

  // Each method waits while a transaction is open and then acts. There is deliberately no `await` between the
  // check and the action: another caller could open a transaction in that gap and we would run inside it.
  async get(sql, ...params) { while (this.#active) await this.#active; return super.get(sql, ...params); }
  async all(sql, ...params) { while (this.#active) await this.#active; return super.all(sql, ...params); }
  async run(sql, ...params) { while (this.#active) await this.#active; return super.run(sql, ...params); }
  async exec(sql) { while (this.#active) await this.#active; return super.exec(sql); }

  // Runs work(scopedDb) inside one transaction. Commits when it resolves, rolls back when it throws.
  async tx(work) {
    while (this.#active) await this.#active;
    this.#raw.exec('BEGIN IMMEDIATE');
    let finish;
    this.#active = new Promise(resolve => { finish = resolve; });
    try {
      const result = await work(new Scoped(this.#raw));
      this.#raw.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#raw.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
      throw error;
    } finally {
      this.#active = null;
      finish();
    }
  }
}

// One door per connection, so everything that shares a connection also shares the waiting.
const doors = new WeakMap();
export function sqlFor(database) {
  let door = doors.get(database);
  if (!door) { door = new SqliteDb(database); doors.set(database, door); }
  return door;
}
