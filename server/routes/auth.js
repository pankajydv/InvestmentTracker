const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const { authBypassed } = require('../middleware/auth');

const DEFAULT_ALLOWED_EMAILS = [
  'pankaj.ydv@gmail.com',
  'hianju.yadav@gmail.com',
  'yashita.ydv@gmail.com',
];

function parseAllowedEmails() {
  const raw = process.env.ALLOWED_EMAILS;
  const list = raw
    ? raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ALLOWED_EMAILS;
  return new Set(list);
}

module.exports = function authRouter() {
  const router = express.Router();

  router.get('/config', (req, res) => {
    res.json({
      enabled: !authBypassed(),
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
      allowedEmailsConfigured: parseAllowedEmails().size,
    });
  });

  router.post('/google', async (req, res) => {
    if (authBypassed()) {
      return res.status(400).json({
        error: 'Auth is disabled. Set GOOGLE_CLIENT_ID and AUTH_DISABLED=false to enable Google auth.',
      });
    }

    const credential = req.body && req.body.credential;
    if (!credential) {
      return res.status(400).json({ error: 'Missing Google credential token' });
    }

    try {
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
      const ticket = await client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      const email = (payload && payload.email ? payload.email : '').toLowerCase();
      const emailVerified = !!(payload && payload.email_verified);

      if (!email || !emailVerified) {
        return res.status(403).json({ error: 'Email not verified by Google' });
      }

      const allowedEmails = parseAllowedEmails();
      if (!allowedEmails.has(email)) {
        return res.status(403).json({ error: 'This Google account is not allowed to access this app' });
      }

      const user = {
        email,
        name: payload.name || email,
        picture: payload.picture || null,
      };

      req.session.user = user;
      req.session.save((err) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to persist session' });
        }
        return res.json({ user });
      });
    } catch (e) {
      return res.status(401).json({ error: `Google token verification failed: ${e.message}` });
    }
  });

  router.get('/me', (req, res) => {
    if (authBypassed()) {
      return res.json({
        user: {
          email: 'local@dev',
          name: 'Local Dev (Auth Disabled)',
          picture: null,
        },
        authDisabled: true,
      });
    }

    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    return res.json({ user: req.session.user, authDisabled: false });
  });

  router.post('/logout', (req, res) => {
    if (!req.session) return res.json({ success: true });

    req.session.destroy(() => {
      res.clearCookie('itrack.sid');
      res.json({ success: true });
    });
  });

  return router;
};
