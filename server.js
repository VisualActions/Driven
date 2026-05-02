const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? null : 'driven-dev-secret-change-me');
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET must be set in production. Refusing to start.');
  process.exit(1);
}
const TRUST_PROXY = process.env.TRUST_PROXY || 1;
const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? process.env.COOKIE_SECURE === '1'
  : IS_PROD;

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'driven.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_color TEXT DEFAULT '#5865f2',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    icon_color TEXT DEFAULT '#5865f2',
    created_at INTEGER NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS server_members (
    server_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id),
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    topic TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS invites (
    code TEXT PRIMARY KEY,
    server_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS friendships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id INTEGER NOT NULL,
    addressee_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    UNIQUE (requester_id, addressee_id),
    FOREIGN KEY (requester_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (addressee_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS dms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_a INTEGER NOT NULL,
    user_b INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (user_a, user_b),
    FOREIGN KEY (user_a) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_b) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dm_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (dm_id) REFERENCES dms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
  CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id);
  CREATE INDEX IF NOT EXISTS idx_member_user ON server_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_friend_addressee ON friendships(addressee_id, status);
  CREATE INDEX IF NOT EXISTS idx_friend_requester ON friendships(requester_id, status);
  CREATE INDEX IF NOT EXISTS idx_dm_messages ON dm_messages(dm_id, id);
`);

const app = express();
const server = http.createServer(app);
const ORIGIN = process.env.CORS_ORIGIN || true;
const io = new Server(server, { cors: { origin: ORIGIN, credentials: true } });

app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const rateBuckets = new Map();
function rateLimit({ windowMs = 60_000, max = 20, key = (req) => req.ip } = {}) {
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    const b = rateBuckets.get(k) || { count: 0, reset: now + windowMs };
    if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
    b.count++;
    rateBuckets.set(k, b);
    if (b.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
app.use(['/api/login', '/api/register'], rateLimit({ windowMs: 60_000, max: 10 }));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: IS_PROD ? '7d' : 0 }));
app.get('/healthz', (req, res) => res.json({ ok: true, env: NODE_ENV }));

const COLORS = ['#5865f2','#eb459e','#57f287','#fee75c','#ed4245','#9b59b6','#1abc9c','#e67e22'];
const randomColor = () => COLORS[Math.floor(Math.random() * COLORS.length)];
const randomCode = (n = 8) => crypto.randomBytes(16).toString('base64url').slice(0, n);

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}
function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE,
    maxAge: 30 * 24 * 3600 * 1000,
  });
}
function authMiddleware(req, res, next) {
  const token = req.cookies.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function isMember(serverId, userId) {
  return !!db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?').get(serverId, userId);
}
function userCanAccessChannel(channelId, userId) {
  const row = db.prepare(`
    SELECT 1 FROM channels c
    JOIN server_members sm ON sm.server_id = c.server_id
    WHERE c.id = ? AND sm.user_id = ?
  `).get(channelId, userId);
  return !!row;
}

// ---------------- AUTH ----------------
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) return res.status(400).json({ error: 'All fields required' });
  if (username.length < 3 || username.length > 24) return res.status(400).json({ error: 'Username must be 3-24 chars' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ chars' });
  if (!/^[\w.-]+@[\w.-]+\.\w+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(
      'INSERT INTO users (username, email, password_hash, avatar_color, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, email.toLowerCase(), hash, randomColor(), Date.now());
    const user = { id: info.lastInsertRowid, username, email };
    const token = sign(user);
    setAuthCookie(res, token);
    res.json({ token, user });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const row = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username.toLowerCase());
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const user = { id: row.id, username: row.username, email: row.email };
  setAuthCookie(res, sign(user));
  res.json({ user });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT id, username, email, avatar_color FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// ---------------- SERVERS (guilds) ----------------
app.get('/api/servers', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.icon_color, s.owner_id, sm.role
    FROM servers s
    JOIN server_members sm ON sm.server_id = s.id
    WHERE sm.user_id = ?
    ORDER BY sm.joined_at ASC
  `).all(req.user.id);
  res.json(rows);
});

app.post('/api/servers', authMiddleware, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Server name required' });
  const now = Date.now();
  const tx = db.transaction(() => {
    const sInfo = db.prepare(
      'INSERT INTO servers (name, owner_id, icon_color, created_at) VALUES (?, ?, ?, ?)'
    ).run(name, req.user.id, randomColor(), now);
    const serverId = sInfo.lastInsertRowid;
    db.prepare(
      'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
    ).run(serverId, req.user.id, 'owner', now);
    db.prepare('INSERT INTO channels (server_id, name, topic, created_at) VALUES (?, ?, ?, ?)')
      .run(serverId, 'general', `Welcome to ${name}!`, now);
    return serverId;
  });
  const id = tx();
  const srv = db.prepare('SELECT id, name, icon_color, owner_id FROM servers WHERE id = ?').get(id);
  res.json({ ...srv, role: 'owner' });
});

app.post('/api/servers/:id/leave', authMiddleware, (req, res) => {
  const serverId = Number(req.params.id);
  const srv = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!srv) return res.status(404).json({ error: 'Not found' });
  if (srv.owner_id === req.user.id) return res.status(400).json({ error: 'Owner cannot leave; delete the server instead' });
  db.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', authMiddleware, (req, res) => {
  const serverId = Number(req.params.id);
  const srv = db.prepare('SELECT owner_id FROM servers WHERE id = ?').get(serverId);
  if (!srv) return res.status(404).json({ error: 'Not found' });
  if (srv.owner_id !== req.user.id) return res.status(403).json({ error: 'Only the owner can delete' });
  db.prepare('DELETE FROM servers WHERE id = ?').run(serverId);
  res.json({ ok: true });
});

// ---------------- CHANNELS ----------------
app.get('/api/servers/:id/channels', authMiddleware, (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  const rows = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY id ASC').all(serverId);
  res.json(rows);
});

app.post('/api/servers/:id/channels', authMiddleware, (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  const name = String(req.body?.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
  if (!name) return res.status(400).json({ error: 'Invalid channel name' });
  const info = db.prepare('INSERT INTO channels (server_id, name, topic, created_at) VALUES (?, ?, ?, ?)')
    .run(serverId, name, `Welcome to #${name}`, Date.now());
  const channel = { id: info.lastInsertRowid, server_id: serverId, name, topic: `Welcome to #${name}` };
  io.to(`server:${serverId}`).emit('channel:new', channel);
  res.json(channel);
});

app.get('/api/channels/:id/messages', authMiddleware, (req, res) => {
  const cid = Number(req.params.id);
  if (!userCanAccessChannel(cid, req.user.id)) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(`
    SELECT m.id, m.channel_id, m.content, m.created_at, u.id as user_id, u.username, u.avatar_color
    FROM messages m JOIN users u ON u.id = m.user_id
    WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 100
  `).all(cid);
  res.json(rows.reverse());
});

app.get('/api/servers/:id/members', authMiddleware, (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  const rows = db.prepare(`
    SELECT u.id, u.username, u.avatar_color, sm.role
    FROM server_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.server_id = ?
    ORDER BY sm.role = 'owner' DESC, u.username ASC
  `).all(serverId);
  res.json(rows);
});

// ---------------- INVITES ----------------
app.post('/api/servers/:id/invites', authMiddleware, (req, res) => {
  const serverId = Number(req.params.id);
  if (!isMember(serverId, req.user.id)) return res.status(403).json({ error: 'Not a member' });
  const code = randomCode(8);
  const expiresInDays = Math.min(Number(req.body?.expiresInDays) || 7, 365);
  const maxUses = req.body?.maxUses != null ? Math.max(1, Number(req.body.maxUses)) : null;
  db.prepare(`
    INSERT INTO invites (code, server_id, created_by, created_at, expires_at, max_uses, uses)
    VALUES (?, ?, ?, ?, ?, ?, 0)
  `).run(code, serverId, req.user.id, Date.now(), Date.now() + expiresInDays * 86400000, maxUses);
  res.json({ code, url: `${req.protocol}://${req.get('host')}/invite/${code}` });
});

app.get('/api/invites/:code', (req, res) => {
  const inv = db.prepare(`
    SELECT i.code, i.expires_at, i.max_uses, i.uses, s.id as server_id, s.name, s.icon_color
    FROM invites i JOIN servers s ON s.id = i.server_id
    WHERE i.code = ?
  `).get(req.params.code);
  if (!inv) return res.status(404).json({ error: 'Invalid invite' });
  if (inv.expires_at && inv.expires_at < Date.now()) return res.status(410).json({ error: 'Invite expired' });
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return res.status(410).json({ error: 'Invite is used up' });
  res.json(inv);
});

app.post('/api/invites/:code/accept', authMiddleware, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code = ?').get(req.params.code);
  if (!inv) return res.status(404).json({ error: 'Invalid invite' });
  if (inv.expires_at && inv.expires_at < Date.now()) return res.status(410).json({ error: 'Invite expired' });
  if (inv.max_uses != null && inv.uses >= inv.max_uses) return res.status(410).json({ error: 'Invite is used up' });

  const already = isMember(inv.server_id, req.user.id);
  if (!already) {
    db.prepare('INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
      .run(inv.server_id, req.user.id, 'member', Date.now());
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(req.params.code);
    const u = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(req.user.id);
    io.to(`server:${inv.server_id}`).emit('member:join', { server_id: inv.server_id, user: { ...u, role: 'member' } });
  }
  const srv = db.prepare('SELECT id, name, icon_color, owner_id FROM servers WHERE id = ?').get(inv.server_id);
  res.json({ server: srv, alreadyMember: already });
});

// ---------------- FRIENDS ----------------
function friendStatus(aId, bId) {
  return db.prepare(`
    SELECT id, requester_id, addressee_id, status FROM friendships
    WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)
  `).get(aId, bId, bId, aId);
}

app.get('/api/friends', authMiddleware, (req, res) => {
  const me = req.user.id;
  const accepted = db.prepare(`
    SELECT u.id, u.username, u.avatar_color
    FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
    ORDER BY u.username
  `).all(me, me, me);
  const incoming = db.prepare(`
    SELECT f.id as request_id, u.id, u.username, u.avatar_color
    FROM friendships f JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(me);
  const outgoing = db.prepare(`
    SELECT f.id as request_id, u.id, u.username, u.avatar_color
    FROM friendships f JOIN users u ON u.id = f.addressee_id
    WHERE f.requester_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(me);
  res.json({ accepted, incoming, outgoing });
});

app.post('/api/friends/request', authMiddleware, (req, res) => {
  const username = String(req.body?.username || '').trim();
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = db.prepare('SELECT id, username, avatar_color FROM users WHERE username = ?').get(username);
  if (!target) return res.status(404).json({ error: 'No user with that username' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't friend yourself" });

  const existing = friendStatus(req.user.id, target.id);
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends' });
    if (existing.requester_id === req.user.id) return res.status(409).json({ error: 'Request already sent' });
    // They sent us a request; auto-accept
    db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(existing.id);
    notifyFriendChange(req.user.id);
    notifyFriendChange(target.id);
    return res.json({ status: 'accepted', friend: target });
  }
  db.prepare(`
    INSERT INTO friendships (requester_id, addressee_id, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `).run(req.user.id, target.id, Date.now());
  notifyFriendChange(req.user.id);
  notifyFriendChange(target.id);
  res.json({ status: 'pending', friend: target });
});

app.post('/api/friends/:requestId/accept', authMiddleware, (req, res) => {
  const id = Number(req.params.requestId);
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.addressee_id !== req.user.id) return res.status(403).json({ error: 'Not your request' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Already resolved' });
  db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(id);
  notifyFriendChange(row.requester_id);
  notifyFriendChange(row.addressee_id);
  res.json({ ok: true });
});

app.post('/api/friends/:requestId/decline', authMiddleware, (req, res) => {
  const id = Number(req.params.requestId);
  const row = db.prepare('SELECT * FROM friendships WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.addressee_id !== req.user.id && row.requester_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM friendships WHERE id = ?').run(id);
  notifyFriendChange(row.requester_id);
  notifyFriendChange(row.addressee_id);
  res.json({ ok: true });
});

app.delete('/api/friends/:userId', authMiddleware, (req, res) => {
  const otherId = Number(req.params.userId);
  const row = friendStatus(req.user.id, otherId);
  if (!row) return res.status(404).json({ error: 'Not friends' });
  db.prepare('DELETE FROM friendships WHERE id = ?').run(row.id);
  notifyFriendChange(req.user.id);
  notifyFriendChange(otherId);
  res.json({ ok: true });
});

// ---------------- DMs ----------------
function pairKey(a, b) { return a < b ? [a, b] : [b, a]; }

function getOrCreateDM(userId, otherId) {
  const [ua, ub] = pairKey(userId, otherId);
  let row = db.prepare('SELECT * FROM dms WHERE user_a = ? AND user_b = ?').get(ua, ub);
  if (!row) {
    const info = db.prepare('INSERT INTO dms (user_a, user_b, created_at) VALUES (?, ?, ?)')
      .run(ua, ub, Date.now());
    row = { id: info.lastInsertRowid, user_a: ua, user_b: ub };
  }
  return row;
}

app.get('/api/dms', authMiddleware, (req, res) => {
  const me = req.user.id;
  const rows = db.prepare(`
    SELECT d.id, d.created_at,
      u.id as other_id, u.username as other_username, u.avatar_color as other_avatar_color,
      (SELECT content FROM dm_messages WHERE dm_id = d.id ORDER BY id DESC LIMIT 1) as last_message,
      (SELECT created_at FROM dm_messages WHERE dm_id = d.id ORDER BY id DESC LIMIT 1) as last_message_at
    FROM dms d
    JOIN users u ON u.id = CASE WHEN d.user_a = ? THEN d.user_b ELSE d.user_a END
    WHERE d.user_a = ? OR d.user_b = ?
    ORDER BY COALESCE(last_message_at, d.created_at) DESC
  `).all(me, me, me);
  res.json(rows);
});

app.post('/api/dms', authMiddleware, (req, res) => {
  const otherId = Number(req.body?.userId);
  if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  const fr = friendStatus(req.user.id, otherId);
  if (!fr || fr.status !== 'accepted') return res.status(403).json({ error: 'You can only DM friends' });
  const dm = getOrCreateDM(req.user.id, otherId);
  const other = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(otherId);
  res.json({
    id: dm.id,
    other_id: other.id, other_username: other.username, other_avatar_color: other.avatar_color
  });
});

app.get('/api/dms/:id/messages', authMiddleware, (req, res) => {
  const dmId = Number(req.params.id);
  const dm = db.prepare('SELECT * FROM dms WHERE id = ?').get(dmId);
  if (!dm) return res.status(404).json({ error: 'Not found' });
  if (dm.user_a !== req.user.id && dm.user_b !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(`
    SELECT m.id, m.dm_id, m.content, m.created_at, u.id as user_id, u.username, u.avatar_color
    FROM dm_messages m JOIN users u ON u.id = m.user_id
    WHERE m.dm_id = ? ORDER BY m.id DESC LIMIT 100
  `).all(dmId);
  res.json(rows.reverse());
});

function userInDM(dmId, userId) {
  const r = db.prepare('SELECT 1 FROM dms WHERE id = ? AND (user_a = ? OR user_b = ?)').get(dmId, userId, userId);
  return !!r;
}

function notifyFriendChange(userId) {
  io.to(`user:${userId}`).emit('friends:update');
}

app.get('/invite/:code', (req, res) => {
  res.redirect(`/?invite=${encodeURIComponent(req.params.code)}`);
});

// ---------------- SOCKET.IO ----------------
io.use((socket, next) => {
  const cookies = socket.handshake.headers.cookie || '';
  const token = (cookies.match(/token=([^;]+)/) || [])[1] || socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

const onlineByServer = new Map(); // serverId -> Map<userId, count>

function emitPresence(serverId) {
  const map = onlineByServer.get(serverId);
  const userIds = map ? Array.from(map.keys()) : [];
  if (!userIds.length) {
    io.to(`server:${serverId}`).emit('presence', { server_id: serverId, online: [] });
    return;
  }
  const placeholders = userIds.map(() => '?').join(',');
  const users = db.prepare(
    `SELECT id, username, avatar_color FROM users WHERE id IN (${placeholders})`
  ).all(...userIds);
  io.to(`server:${serverId}`).emit('presence', { server_id: serverId, online: users });
}

io.on('connection', (socket) => {
  const u = db.prepare('SELECT id, username, avatar_color FROM users WHERE id = ?').get(socket.user.id);
  if (!u) return socket.disconnect();

  socket.join(`user:${u.id}`);

  const myServers = db.prepare('SELECT server_id FROM server_members WHERE user_id = ?').all(u.id).map(r => r.server_id);
  for (const sid of myServers) {
    socket.join(`server:${sid}`);
    if (!onlineByServer.has(sid)) onlineByServer.set(sid, new Map());
    const m = onlineByServer.get(sid);
    m.set(u.id, (m.get(u.id) || 0) + 1);
  }
  for (const sid of myServers) emitPresence(sid);

  socket.on('joinChannel', (channelId) => {
    if (!userCanAccessChannel(channelId, u.id)) return;
    for (const room of socket.rooms) {
      if (room.startsWith('channel:')) socket.leave(room);
    }
    socket.join(`channel:${channelId}`);
  });

  socket.on('joinServer', (serverId) => {
    if (!isMember(serverId, u.id)) return;
    socket.join(`server:${serverId}`);
    if (!onlineByServer.has(serverId)) onlineByServer.set(serverId, new Map());
    const m = onlineByServer.get(serverId);
    m.set(u.id, (m.get(u.id) || 0) + 1);
    emitPresence(serverId);
  });

  socket.on('message', ({ channelId, content }) => {
    const text = String(content || '').trim().slice(0, 2000);
    if (!text || !channelId) return;
    if (!userCanAccessChannel(channelId, u.id)) return;
    const info = db.prepare(
      'INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(channelId, u.id, text, Date.now());
    const msg = {
      id: info.lastInsertRowid,
      channel_id: channelId,
      user_id: u.id,
      username: u.username,
      avatar_color: u.avatar_color,
      content: text,
      created_at: Date.now(),
    };
    io.to(`channel:${channelId}`).emit('message', msg);
  });

  socket.on('typing', ({ channelId }) => {
    if (!userCanAccessChannel(channelId, u.id)) return;
    socket.to(`channel:${channelId}`).emit('typing', { username: u.username, channelId });
  });

  socket.on('joinDM', (dmId) => {
    if (!userInDM(dmId, u.id)) return;
    for (const room of socket.rooms) if (room.startsWith('dm:')) socket.leave(room);
    socket.join(`dm:${dmId}`);
  });

  socket.on('dmMessage', ({ dmId, content }) => {
    const text = String(content || '').trim().slice(0, 2000);
    if (!text || !dmId) return;
    if (!userInDM(dmId, u.id)) return;
    const info = db.prepare(
      'INSERT INTO dm_messages (dm_id, user_id, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(dmId, u.id, text, Date.now());
    const msg = {
      id: info.lastInsertRowid,
      dm_id: dmId,
      user_id: u.id,
      username: u.username,
      avatar_color: u.avatar_color,
      content: text,
      created_at: Date.now(),
    };
    io.to(`dm:${dmId}`).emit('dmMessage', msg);
    // also nudge both users' inbox so DM list refreshes
    const dm = db.prepare('SELECT user_a, user_b FROM dms WHERE id = ?').get(dmId);
    if (dm) {
      io.to(`user:${dm.user_a}`).emit('dm:update', { dmId });
      io.to(`user:${dm.user_b}`).emit('dm:update', { dmId });
    }
  });

  socket.on('dmTyping', ({ dmId }) => {
    if (!userInDM(dmId, u.id)) return;
    socket.to(`dm:${dmId}`).emit('dmTyping', { username: u.username, dmId });
  });

  socket.on('disconnect', () => {
    for (const sid of myServers) {
      const m = onlineByServer.get(sid);
      if (!m) continue;
      const c = (m.get(u.id) || 1) - 1;
      if (c <= 0) m.delete(u.id); else m.set(u.id, c);
      emitPresence(sid);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Driven [${NODE_ENV}] running on http://localhost:${PORT}`);
});

function shutdown(sig) {
  console.log(`\n${sig} received, shutting down...`);
  io.close();
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));
