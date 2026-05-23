function authBypassed() {
  const appMode = String(process.env.APP_MODE || 'production').toLowerCase();
  return process.env.AUTH_DISABLED === 'true' || appMode === 'test' || !process.env.GOOGLE_CLIENT_ID;
}

function requireAuth(req, res, next) {
  if (authBypassed()) return next();

  if (req.session && req.session.user && req.session.user.email) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { requireAuth, authBypassed };
