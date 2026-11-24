const crypto = require('crypto');
const { db } = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  if (row && row.value) return row.value;
  const generated = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('session_secret', ?)").run(generated);
  return generated;
}

const SECRET = getSessionSecret();

function signPayload(b64) {
  return crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
}

function createSession(user) {
  const payload = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    shift: user.shift,
    exp: Date.now() + SESSION_TTL_MS
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = signPayload(b64);
  return `${b64}.${sig}`;
}

function getSession(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  if (!b64 || !sig) return null;
  const expected = signPayload(b64);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!payload || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function deleteSession(_token) {
  // Stateless signed cookie; cleared on client via res.clearCookie
}

function requireAuth(req, res, next) {
  const token = req.cookies?.cr_session;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function resolveAllowedShift(user, requestedShift) {
  if (user.role === 'cr') {
    return user.shift;
  }
  if (requestedShift === 'morning' || requestedShift === 'evening') {
    return requestedShift;
  }
  return 'morning';
}

module.exports = {
  createSession,
  getSession,
  deleteSession,
  requireAuth,
  requireAdmin,
  resolveAllowedShift
};
