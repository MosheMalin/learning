// D1's statement API on top of Node's built-in SQLite, so the fold runs its
// real SQL in a unit test with no wrangler and no network. Only what the
// Worker uses is mirrored: prepare().bind().first()/all()/run(), and exec.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = path.join(__dirname, '..', '..', 'tracker', 'migrations');

class Statement {
  constructor(st) { this.st = st; this.args = []; }
  bind(...args) { this.args = args.map(a => (a === undefined ? null : a)); return this; }
  async first(col) {
    const row = this.st.get(...this.args);
    if (row === undefined) return null;
    return col ? row[col] : row;
  }
  async all() { return { results: this.st.all(...this.args), success: true }; }
  async run() {
    const r = this.st.run(...this.args);
    return { success: true, meta: { changes: r.changes } };
  }
}

class D1Like {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Statement(this.db.prepare(sql)); }
  exec(sql) { this.db.exec(sql); }
}

/* The same database, but the Nth statement run throws - a D1 hiccup mid-batch. */
function failingAt(db, nth) {
  let count = 0;
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      const run = st.run.bind(st);
      st.run = async (...a) => { if (++count === nth) throw new Error('D1_ERROR: storage reset'); return run(...a); };
      return st;
    },
  };
}

/* A fresh database with every migration applied, in order. */
function freshDb() {
  const db = new D1Like();
  for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
  }
  return db;
}

module.exports = { D1Like, freshDb, failingAt };
