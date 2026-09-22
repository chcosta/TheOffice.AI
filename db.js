const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let _dbInstance = null;
let _dbPath = null;

function _atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, filePath);
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
  }
}

function _assertHealthy(sqlDb) {
  const result = sqlDb.exec('PRAGMA quick_check');
  const values = result.length && Array.isArray(result[0].values) ? result[0].values : [];
  if (values.length !== 1 || values[0][0] !== 'ok') {
    throw new Error('SQLite integrity check failed');
  }
}

function _openChecked(SQL, buffer) {
  if (!buffer || buffer.length === 0) {
    throw new Error('SQLite database file is empty');
  }
  const db = new SQL.Database(buffer);
  try {
    _assertHealthy(db);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function _quarantine(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let i = 0; i < 10; i++) {
    const suffix = i ? `-${i}` : '';
    const target = `${filePath}.corrupt-${stamp}${suffix}`;
    try {
      fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
      return target;
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw new Error(`Could not preserve malformed database at ${target}: ${error.message}`);
    }
  }
  throw new Error('Could not allocate a unique quarantine path for malformed database');
}

/**
 * Thin synchronous wrapper around sql.js that mimics better-sqlite3 API subset.
 */
class DbWrapper {
  constructor(sqlDb, filePath, initialData = null) {
    this._db = sqlDb;
    this._path = filePath;
    this._lastPersisted = initialData;
  }

  exec(sql) {
    this._db.run(sql);
    this._save();
  }

  prepare(sql) {
    return new StatementWrapper(this._db, sql, this);
  }

  close() {
    this._save();
    this._db.close();
  }

  pragma() { /* no-op for compatibility */ }

  _save() {
    if (this._path) {
      const data = Buffer.from(this._db.export());
      if (this._lastPersisted) {
        _atomicWrite(this._path + '.bak', this._lastPersisted);
      }
      _atomicWrite(this._path, data);
      this._lastPersisted = data;
    }
  }
}

class StatementWrapper {
  constructor(db, sql, wrapper) {
    this._db = db;
    this._sql = sql;
    this._wrapper = wrapper;
  }

  run(...params) {
    this._db.run(this._sql, params);
    // Query last_insert_rowid BEFORE save (export may reset state)
    const lastId = this._db.exec("SELECT last_insert_rowid() as id");
    const lastInsertRowid = lastId.length > 0 ? lastId[0].values[0][0] : 0;
    const changes = this._db.getRowsModified();
    this._wrapper._save();
    return { lastInsertRowid, changes };
  }

  get(...params) {
    const stmt = this._db.prepare(this._sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return undefined;
  }

  all(...params) {
    const results = [];
    const stmt = this._db.prepare(this._sql);
    stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }
}

async function openDatabase(filePath) {
  const SQL = await initSqlJs();
  let db;
  let initialData = null;
  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath);
    try {
      db = _openChecked(SQL, buffer);
      initialData = buffer;
    } catch (error) {
      const quarantine = _quarantine(filePath);
      const backupPath = filePath + '.bak';
      if (fs.existsSync(backupPath)) {
        try {
          const backup = fs.readFileSync(backupPath);
          db = _openChecked(SQL, backup);
          initialData = backup;
          _atomicWrite(filePath, backup);
          console.error(`[database] Recovered malformed database from ${backupPath}; original preserved at ${quarantine}`);
        } catch {
          db = null;
        }
      }
      if (!db) {
        db = new SQL.Database();
        console.error(`[database] Malformed database could not be recovered; starting clean. Original preserved at ${quarantine}`);
      }
    }
  } else {
    db = new SQL.Database();
  }
  return new DbWrapper(db, filePath, initialData);
}

module.exports = { openDatabase };
