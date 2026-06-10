const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let _dbInstance = null;
let _dbPath = null;

/**
 * Thin synchronous wrapper around sql.js that mimics better-sqlite3 API subset.
 */
class DbWrapper {
  constructor(sqlDb, filePath) {
    this._db = sqlDb;
    this._path = filePath;
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
      const data = this._db.export();
      fs.writeFileSync(this._path, Buffer.from(data));
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
    this._wrapper._save();
    // Return info object mimicking better-sqlite3 API
    const lastId = this._db.exec("SELECT last_insert_rowid() as id");
    const lastInsertRowid = lastId.length > 0 ? lastId[0].values[0][0] : 0;
    return { lastInsertRowid, changes: this._db.getRowsModified() };
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
  if (fs.existsSync(filePath)) {
    const buffer = fs.readFileSync(filePath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  return new DbWrapper(db, filePath);
}

module.exports = { openDatabase };
