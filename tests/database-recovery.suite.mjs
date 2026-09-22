import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from './lib/harness.mjs';

const t = createRunner('database-recovery.suite');
const require = createRequire(import.meta.url);
const { openDatabase } = require(path.join(process.cwd(), 'db.js'));

await t.test('database writes are atomic and retain a known-good backup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'theoffice-db-'));
  const file = path.join(dir, 'supervisor.db');
  try {
    const db = await openDatabase(file);
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO sample (value) VALUES (?)').run('first');
    db.prepare('INSERT INTO sample (value) VALUES (?)').run('second');
    t.ok(readFileSync(file).length > 0 && readFileSync(file + '.bak').length > 0,
      'current database and previous known-good image are persisted');
    t.eq(db.prepare('SELECT count(*) AS count FROM sample').get().count, 2,
      'current database remains queryable');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await t.test('startup restores a malformed database from its backup', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'theoffice-db-'));
  const file = path.join(dir, 'supervisor.db');
  try {
    const original = await openDatabase(file);
    original.exec('CREATE TABLE sample (value TEXT)');
    original.prepare('INSERT INTO sample (value) VALUES (?)').run('preserved');
    original.close();
    writeFileSync(file, Buffer.from('not a sqlite database'));

    const recovered = await openDatabase(file);
    t.eq(recovered.prepare('SELECT value FROM sample').get().value, 'preserved',
      'known-good backup data is restored automatically');
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await t.test('startup treats a zero-byte database as corruption', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'theoffice-db-'));
  const file = path.join(dir, 'supervisor.db');
  try {
    const original = await openDatabase(file);
    original.exec('CREATE TABLE sample (value TEXT)');
    original.prepare('INSERT INTO sample (value) VALUES (?)').run('preserved');
    original.close();
    writeFileSync(file, Buffer.alloc(0));

    const recovered = await openDatabase(file);
    t.eq(recovered.prepare('SELECT value FROM sample').get().value, 'preserved',
      'zero-byte truncation restores the known-good backup');
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await t.test('startup quarantines unrecoverable data and initializes cleanly', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'theoffice-db-'));
  const file = path.join(dir, 'supervisor.db');
  try {
    writeFileSync(file, Buffer.from('not a sqlite database'));
    const db = await openDatabase(file);
    db.exec('CREATE TABLE initialized (id INTEGER)');
    t.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'initialized'").get(),
      'a clean database remains usable when no backup can be recovered');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

t.done();
