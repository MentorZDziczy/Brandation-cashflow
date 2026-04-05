'use strict';
const express    = require('express');
const session    = require('express-session');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const fs         = require('fs');

const app        = express();
const PORT       = process.env.PORT || 3000;
const LOCK_TTL   = 10 * 60 * 1000; // 10 minut

// ── In-memory lock ─────────────────────────────────────────────────────────
let lock = null;
function lockValid()  { return lock && Date.now() < lock.expiresAt; }
function sweepLock()  { if (lock && Date.now() >= lock.expiresAt) lock = null; }

// ══════════════════════════════════════════════════════════════════════════
//  STORAGE — PostgreSQL gdy DATABASE_URL, inaczej pliki JSON (lokalnie)
// ══════════════════════════════════════════════════════════════════════════
let db; // będzie Pool jeśli PostgreSQL

if (process.env.DATABASE_URL) {
  // ── PostgreSQL ────────────────────────────────────────────────────────
  const { Pool } = require('pg');
  db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  // Inicjalizacja tabel przy starcie
  db.query(`
    CREATE TABLE IF NOT EXISTS app_data (
      id      INTEGER PRIMARY KEY DEFAULT 1,
      payload JSONB   NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS app_users (
      username      TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL
    );
  `).then(async () => {
    // Domyślny admin jeśli brak użytkowników
    const res = await db.query('SELECT 1 FROM app_users LIMIT 1');
    if (res.rowCount === 0) {
      const hash = await bcrypt.hash('Brandation2025', 10);
      await db.query(
        'INSERT INTO app_users VALUES ($1,$2,$3)',
        ['admin', 'Administrator', hash]
      );
      console.log('✔  Domyślny użytkownik: admin / Brandation2025');
    }
  }).catch(console.error);

  // Sesje w PostgreSQL
  const pgSession = require('connect-pg-simple')(session);
  app.use(session({
    store:             new pgSession({ pool: db, createTableIfMissing: true }),
    secret:            process.env.SESSION_SECRET || 'brandation-cf-x9k2m7v3',
    resave:            false,
    saveUninitialized: false,
    cookie:            { maxAge: 24 * 60 * 60 * 1000 }
  }));

} else {
  // ── Lokalnie: pliki JSON ──────────────────────────────────────────────
  const DATA_FILE  = path.join(__dirname, 'cashflow-data.json');
  const USERS_FILE = path.join(__dirname, 'users.json');

  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify([{
      username:     'admin',
      displayName:  'Administrator',
      passwordHash: bcrypt.hashSync('Brandation2025', 10)
    }], null, 2));
    console.log('✔  Utworzono users.json → admin / Brandation2025');
  }

  db = {
    _mode: 'file',
    DATA_FILE, USERS_FILE,
    query: null   // nie używane w trybie plikowym
  };

  app.use(session({
    secret:            'brandation-cf-x9k2m7v3',
    resave:            false,
    saveUninitialized: false,
    cookie:            { maxAge: 24 * 60 * 60 * 1000 }
  }));
}

// ══════════════════════════════════════════════════════════════════════════
//  Pomocnicze funkcje odczytu/zapisu (działają w obu trybach)
// ══════════════════════════════════════════════════════════════════════════
async function readData() {
  if (db._mode === 'file') {
    try { return JSON.parse(fs.readFileSync(db.DATA_FILE, 'utf8')); } catch { return {}; }
  }
  const r = await db.query('SELECT payload FROM app_data WHERE id=1');
  return r.rows[0]?.payload || { accountBalance: null, incs: [], vars: [], fixs: [] };
}

async function writeData(data) {
  if (db._mode === 'file') {
    fs.writeFileSync(db.DATA_FILE, JSON.stringify(data, null, 2));
    return;
  }
  await db.query(
    `INSERT INTO app_data(id,payload) VALUES(1,$1)
     ON CONFLICT(id) DO UPDATE SET payload=$1`,
    [data]
  );
}

async function findUser(username) {
  if (db._mode === 'file') {
    const users = JSON.parse(fs.readFileSync(db.USERS_FILE, 'utf8'));
    const u = users.find(x => x.username === username);
    return u ? { username: u.username, displayName: u.displayName, passwordHash: u.passwordHash } : null;
  }
  const r = await db.query('SELECT * FROM app_users WHERE username=$1', [username]);
  const u = r.rows[0];
  return u ? { username: u.username, displayName: u.display_name, passwordHash: u.password_hash } : null;
}

async function allUsers() {
  if (db._mode === 'file') {
    return JSON.parse(fs.readFileSync(db.USERS_FILE, 'utf8'))
      .map(u => ({ username: u.username, displayName: u.displayName }));
  }
  const r = await db.query('SELECT username, display_name AS "displayName" FROM app_users');
  return r.rows;
}

async function createUser(username, displayName, hash) {
  if (db._mode === 'file') {
    const users = JSON.parse(fs.readFileSync(db.USERS_FILE, 'utf8'));
    users.push({ username, displayName, passwordHash: hash });
    fs.writeFileSync(db.USERS_FILE, JSON.stringify(users, null, 2));
    return;
  }
  await db.query(
    'INSERT INTO app_users(username,display_name,password_hash) VALUES($1,$2,$3)',
    [username, displayName, hash]
  );
}

async function deleteUser(username) {
  if (db._mode === 'file') {
    const users = JSON.parse(fs.readFileSync(db.USERS_FILE, 'utf8'))
      .filter(u => u.username !== username);
    fs.writeFileSync(db.USERS_FILE, JSON.stringify(users, null, 2));
    return;
  }
  await db.query('DELETE FROM app_users WHERE username=$1', [username]);
}

// ══════════════════════════════════════════════════════════════════════════
//  Middleware
// ══════════════════════════════════════════════════════════════════════════
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'cash-flow.html')));

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Nie zalogowano' });
  next();
}

// ══════════════════════════════════════════════════════════════════════════
//  API – Auth
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Podaj login i hasło' });

    const user = await findUser(username);
    if (!user || !await bcrypt.compare(password, user.passwordHash))
      return res.status(401).json({ error: 'Nieprawidłowy login lub hasło' });

    req.session.user = { username: user.username, displayName: user.displayName };
    res.json({ ok: true, user: req.session.user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', auth, (req, res) => {
  sweepLock();
  if (lock && lock.username === req.session.user.username) lock = null;
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// ══════════════════════════════════════════════════════════════════════════
//  API – Data
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/data', auth, async (req, res) => {
  try { res.json(await readData()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/data', auth, async (req, res) => {
  sweepLock();
  if (!lockValid() || lock.username !== req.session.user.username)
    return res.status(423).json({ error: 'Nie masz blokady edycji' });
  lock.expiresAt = Date.now() + LOCK_TTL;
  try { await writeData(req.body); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════
//  API – Lock
// ══════════════════════════════════════════════════════════════════════════
app.get('/api/lock', auth, (req, res) => {
  sweepLock();
  if (!lock) return res.json({ locked: false });
  res.json({
    locked: true, username: lock.username, displayName: lock.displayName,
    acquiredAt: lock.acquiredAt, isYours: lock.username === req.session.user.username
  });
});

app.post('/api/lock/acquire', auth, (req, res) => {
  sweepLock();
  const u = req.session.user;
  if (lock && lock.username !== u.username)
    return res.status(423).json({ error: `Edytuje teraz: ${lock.displayName}`, lockedBy: lock.displayName });
  lock = { username: u.username, displayName: u.displayName, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_TTL };
  res.json({ ok: true });
});

app.post('/api/lock/release', auth, (req, res) => {
  sweepLock();
  if (lock && lock.username === req.session.user.username) lock = null;
  res.json({ ok: true });
});

app.post('/api/lock/force', auth, (req, res) => {
  const u = req.session.user;
  lock = { username: u.username, displayName: u.displayName, acquiredAt: Date.now(), expiresAt: Date.now() + LOCK_TTL };
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  API – Użytkownicy (tylko admin)
// ══════════════════════════════════════════════════════════════════════════
function adminOnly(req, res, next) {
  if (req.session.user?.username !== 'admin')
    return res.status(403).json({ error: 'Brak dostępu' });
  next();
}

app.get('/api/users', auth, adminOnly, async (req, res) => {
  res.json(await allUsers());
});

app.post('/api/users', auth, adminOnly, async (req, res) => {
  const { username, displayName, password } = req.body || {};
  if (!username || !displayName || !password)
    return res.status(400).json({ error: 'Podaj username, displayName i password' });
  if (await findUser(username))
    return res.status(409).json({ error: 'Użytkownik już istnieje' });
  await createUser(username, displayName, await bcrypt.hash(password, 10));
  res.json({ ok: true });
});

app.delete('/api/users/:username', auth, adminOnly, async (req, res) => {
  if (req.params.username === 'admin')
    return res.status(400).json({ error: 'Nie można usunąć admina' });
  await deleteUser(req.params.username);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════
//  Start
// ══════════════════════════════════════════════════════════════════════════
app.listen(PORT, () => console.log(`\n🚀  http://localhost:${PORT}\n`));
