import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqliteDb, sqlFor } from '../core/db.js';

const fresh = () => { const raw = new DatabaseSync(':memory:'); raw.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)'); return { raw, db: new SqliteDb(raw) }; };
const count = async db => (await db.get('SELECT COUNT(*) AS n FROM t')).n;

test('every method returns a promise and binds parameters, never splicing them into the SQL', async () => {
  const { db } = fresh();
  const calls = [db.exec('INSERT INTO t(v) VALUES(\'a\')'), db.run('INSERT INTO t(v) VALUES(?)', 'b'), db.get('SELECT 1 AS one'), db.all('SELECT 1 AS one')];
  for (const call of calls) assert.ok(call instanceof Promise);
  await Promise.all(calls);
  const hostile = "x'); DROP TABLE t; --";
  const inserted = await db.run('INSERT INTO t(v) VALUES(?)', hostile);
  assert.equal(inserted.changes, 1); assert.equal(typeof inserted.lastInsertRowid, 'number');
  assert.equal((await db.get('SELECT v FROM t WHERE v=?', hostile)).v, hostile);
  assert.deepEqual((await db.all('SELECT v FROM t ORDER BY id')).map(row => row.v), ['a', 'b', hostile]);
  assert.equal(await db.get('SELECT v FROM t WHERE v=?', 'nothing'), undefined);
});

test('tx commits what its work wrote and returns the work\'s value', async () => {
  const { db } = fresh();
  const value = await db.tx(async inner => { await inner.run('INSERT INTO t(v) VALUES(?)', 'kept'); return 42; });
  assert.equal(value, 42); assert.equal(await count(db), 1);
});

test('tx rolls everything back when the work throws, and the error reaches the caller unchanged', async () => {
  const { db } = fresh();
  const boom = new Error('boom');
  await assert.rejects(db.tx(async inner => { await inner.run('INSERT INTO t(v) VALUES(?)', 'gone'); throw boom; }), error => error === boom);
  assert.equal(await count(db), 0);
});

test('a failing statement inside tx rolls back the earlier writes in the same transaction', async () => {
  const { db } = fresh();
  await assert.rejects(db.tx(async inner => { await inner.run('INSERT INTO t(v) VALUES(?)', 'gone'); await inner.run('INSERT INTO t(v) VALUES(NULL)'); }), /NOT NULL/);
  assert.equal(await count(db), 0);
  await db.tx(async inner => inner.run('INSERT INTO t(v) VALUES(?)', 'works after a failure'));
  assert.equal(await count(db), 1, 'the connection is usable after a rollback');
});

test('transactions do not nest, and the refused attempt leaves the outer one intact', async () => {
  const { db } = fresh();
  await assert.rejects(db.tx(async inner => { await inner.run('INSERT INTO t(v) VALUES(?)', 'outer'); await inner.tx(async () => {}); }), /do not nest/);
  assert.equal(await count(db), 0, 'the outer transaction rolled back with its error');
  await db.tx(async inner => inner.run('INSERT INTO t(v) VALUES(?)', 'later'));
  assert.equal(await count(db), 1);
});

test('statements made on the door while a transaction is open wait for it, so they never land inside it', async () => {
  const { db } = fresh();
  const boom = new Error('boom');
  const inside = db.tx(async scoped => {
    await scoped.run('INSERT INTO t(v) VALUES(?)', 'inside');
    await new Promise(resolve => setTimeout(resolve, 20));
    throw boom;
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const outside = db.run('INSERT INTO t(v) VALUES(?)', 'outside');
  await assert.rejects(inside, error => error === boom);
  await outside;
  assert.deepEqual((await db.all('SELECT v FROM t')).map(row => row.v), ['outside'], 'the rollback did not take the outside write with it');
});

test('two transactions started together run one after the other, each whole', async () => {
  const { db } = fresh();
  const order = [];
  const first = db.tx(async scoped => { order.push('first start'); await scoped.run('INSERT INTO t(v) VALUES(?)', 'one'); await new Promise(resolve => setTimeout(resolve, 10)); order.push('first end'); });
  const second = db.tx(async scoped => { order.push('second start'); await scoped.run('INSERT INTO t(v) VALUES(?)', 'two'); order.push('second end'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first start', 'first end', 'second start', 'second end']);
  assert.equal(await count(db), 2);
});

test('a transaction can make many calls on its scoped handle', async () => {
  const { db } = fresh();
  await db.tx(async inner => { for (let n = 0; n < 200; n += 1) await inner.run('INSERT INTO t(v) VALUES(?)', String(n)); });
  assert.equal(await count(db), 200);
});

test('sqlFor gives one door per connection and refuses anything that is not a connection', () => {
  const { raw } = fresh();
  assert.equal(sqlFor(raw), sqlFor(raw));
  assert.notEqual(sqlFor(raw), sqlFor(new DatabaseSync(':memory:')));
  assert.throws(() => new SqliteDb(null), /connection is required/);
  assert.throws(() => new SqliteDb({}), /connection is required/);
});
