const crypto = require('crypto');

// In-memory session store (persists for server lifetime; simple & fast for 2-3 users)
// Also supports optional signed cookie fallback or simple token map.
const sessions = new Map();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    shift: user.shift,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function deleteSession(token) {
  if (token) sessions.delete(token);
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

/**
 * Resolves the effective shift for a request.
 * - If user is a CR (morning or evening), they are strictly locked to their own shift.
 * - If user is admin, they can view/act on 'morning' or 'evening' as requested.
 */
function resolveAllowedShift(user, requestedShift) {
  if (user.role === 'cr') {
    return user.shift; // strictly locked
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
