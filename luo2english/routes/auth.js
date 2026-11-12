const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/postgres');
const { ensurePasswordResetSchema } = db;
const router = express.Router();

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Helper: Validate email format
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Helper: Validate password (min 8 chars)
const isValidPassword = (password) => typeof password === 'string' && password.length >= 8 && Buffer.byteLength(password) <= 72;

const hashResetToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const attemptWindows = new Map();

function tooManyAttempts(req, action) {
  const key = `${action}:${req.ip}`;
  const now = Date.now();
  const entry = attemptWindows.get(key);
  if (!entry || entry.resetAt <= now) {
    attemptWindows.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  } else if (entry.count >= MAX_ATTEMPTS) {
    return true;
  } else {
    entry.count += 1;
  }
  if (attemptWindows.size > 1000) {
    for (const [attemptKey, value] of attemptWindows) {
      if (value.resetAt <= now) attemptWindows.delete(attemptKey);
    }
  }
  return false;
}

function renderForgotPassword(res, { status = 200, errors = [], email = '', sent = false } = {}) {
  return res.status(status).render('forgot-password', {
    title: 'Forgot password',
    errors,
    email,
    sent
  });
}

function renderResetPassword(res, { status = 200, errors = [], token = '', invalid = false } = {}) {
  return res.status(status).render('reset-password', {
    title: 'Reset password',
    errors,
    token,
    invalid
  });
}

async function invalidateSessions(userId) {
  const { rows } = await db.query("SELECT to_regclass('session') AS name");
  if (!rows[0]?.name) return;
  await db.query("DELETE FROM session WHERE sess->>'user_id' = $1", [String(userId)]);
}

// Register page (GET)
router.get('/register', (req, res) => {
  if (req.session.user_id) {
    return res.redirect('/');
  }
  res.render('register', {
    title: 'Register',
    errors: [],
    username: '',
    email: ''
  });
});

// Register (POST)
router.post('/register', async (req, res, next) => {
  const { username, email, password, confirm_password } = req.body;
  const errors = [];

  // Validation
  if (typeof username !== 'string' || username.trim().length < 3) {
    errors.push('Username must be at least 3 characters');
  }
  if (typeof email !== 'string' || !isValidEmail(email)) {
    errors.push('Invalid email format');
  }
  if (!password || !isValidPassword(password)) {
    errors.push('Password must be at least 8 characters and at most 72 bytes');
  }
  if (password !== confirm_password) {
    errors.push('Passwords do not match');
  }

  if (errors.length > 0) {
    return res.render('register', {
      title: 'Register',
      errors,
      username,
      email
    });
  }

  try {
    // Check if username or email already exists
    const existing = (await db.query('SELECT id FROM users WHERE username = $1 OR email = $2',
      [username.toLowerCase(), email.toLowerCase()])).rows[0];

    if (existing) {
      errors.push('Username or email already in use');
      return res.render('register', {
        title: 'Register',
        errors,
        username,
        email
      });
    }

    // Hash password
    const password_hash = bcrypt.hashSync(password, 10);

    // Create user (role defaults to 'user')
    const result = await db.query(`
      INSERT INTO users (username, email, password_hash, role)
      VALUES ($1, $2, $3, 'user') RETURNING id, username, role
    `, [username.toLowerCase(), email.toLowerCase(), password_hash]);

    signIn(req, res, next, result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      errors.push('Username or email already in use');
      return res.render('register', { title: 'Register', errors, username, email });
    }
    console.error(error);
    errors.push('Registration failed. Please try again.');
    res.render('register', {
      title: 'Register',
      errors,
      username,
      email
    });
  }
});

// Login page (GET)
router.get('/login', (req, res) => {
  if (req.session.user_id) {
    return res.redirect('/');
  }
  res.render('login', {
    title: 'Login',
    errors: [],
    username: '',
    success: req.query.reset === '1' ? 'Your password has been reset. Please log in with your new password.' : ''
  });
});

// Login (POST)
router.post('/login', async (req, res, next) => {
  const { username, password } = req.body;
  const errors = [];

  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    errors.push('Username and password required');
  }

  if (errors.length > 0) {
    return res.render('login', {
      title: 'Login',
      errors,
      username,
      success: ''
    });
  }

  try {
    const user = (await db.query('SELECT id, username, password_hash, role FROM users WHERE username = $1',
      [username.toLowerCase()])).rows[0];

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      errors.push('Invalid username or password');
      return res.render('login', {
        title: 'Login',
        errors,
        username
      });
    }

    signIn(req, res, next, user);
  } catch (error) {
    console.error(error);
    errors.push('Login failed. Please try again.');
    res.render('login', {
      title: 'Login',
      errors,
      username,
      success: ''
    });
  }
});

// Forgot password page (GET)
router.get('/forgot-password', (req, res) => {
  renderForgotPassword(res);
});

// Forgot password (POST)
router.post('/forgot-password', async (req, res, next) => {
  if (tooManyAttempts(req, 'forgot-password')) {
    return renderForgotPassword(res, {
      status: 429,
      email: typeof req.body.email === 'string' ? req.body.email.trim() : '',
      errors: ['Too many password reset requests. Please try again later.']
    });
  }

  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!isValidEmail(email)) {
    return renderForgotPassword(res, {
      status: 400,
      email,
      errors: ['Enter a valid email address']
    });
  }

  try {
    await ensurePasswordResetSchema();
    const user = (await db.query(
      'SELECT id, username, email FROM users WHERE lower(email) = $1',
      [email]
    )).rows[0];

    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(token);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

      await db.query(
        'DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at < NOW()',
        [user.id]
      );
      await db.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, expiresAt]
      );

      const baseUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const resetUrl = `${baseUrl}/auth/reset-password?token=${token}`;
      try {
        await req.app.locals.sendPasswordResetEmail({
          to: user.email,
          username: user.username,
          resetUrl
        });
      } catch (mailError) {
        console.error('Password reset email failed:', mailError);
      }
    }

    renderForgotPassword(res, { sent: true });
  } catch (error) {
    console.error(error);
    next(error);
  }
});

// Reset password page (GET)
router.get('/reset-password', async (req, res, next) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) {
    return renderResetPassword(res, {
      status: 400,
      invalid: true,
      errors: ['This password reset link is invalid or has expired.']
    });
  }

  try {
    await ensurePasswordResetSchema();
    const { rows } = await db.query(
      'SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > NOW()',
      [hashResetToken(token)]
    );
    if (!rows[0]) {
      return renderResetPassword(res, {
        status: 400,
        invalid: true,
        errors: ['This password reset link is invalid or has expired.']
      });
    }
    renderResetPassword(res, { token });
  } catch (error) {
    console.error(error);
    next(error);
  }
});

// Reset password (POST)
router.post('/reset-password', async (req, res, next) => {
  const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
  const { password, confirm_password } = req.body;

  if (tooManyAttempts(req, 'reset-password')) {
    return renderResetPassword(res, {
      status: 429,
      token,
      errors: ['Too many attempts. Please try again later.']
    });
  }

  const errors = [];
  if (!token) {
    errors.push('This password reset link is invalid or has expired.');
  }
  if (!password || !isValidPassword(password)) {
    errors.push('Password must be at least 8 characters and at most 72 bytes');
  }
  if (password !== confirm_password) {
    errors.push('Passwords do not match');
  }

  if (errors.length > 0) {
    return renderResetPassword(res, { status: 400, token, errors });
  }

  try {
    await ensurePasswordResetSchema();
    const client = await db.connect();
    let userId;
    try {
      await client.query('BEGIN');
      const consumed = await client.query(
        'DELETE FROM password_reset_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id',
        [hashResetToken(token)]
      );
      userId = consumed.rows[0]?.user_id;
      if (!userId) {
        await client.query('ROLLBACK');
      } else {
        await client.query(
          'UPDATE users SET password_hash = $1 WHERE id = $2',
          [bcrypt.hashSync(password, 10), userId]
        );
        await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
        await client.query('COMMIT');
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    if (!userId) {
      return renderResetPassword(res, {
        status: 400,
        invalid: true,
        errors: ['This password reset link is invalid or has expired.']
      });
    }

    await invalidateSessions(userId);

    if (req.session.user_id === userId) {
      return req.session.destroy(error => {
        if (error) return next(error);
        res.redirect('/auth/login?reset=1');
      });
    }
    res.redirect('/auth/login?reset=1');
  } catch (error) {
    console.error(error);
    next(error);
  }
});

function signIn(req, res, next, user) {
  req.session.regenerate(error => {
    if (error) return next(error);
    req.session.user_id = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.save(error => {
      if (error) return next(error);
      res.redirect('/');
    });
  });
}

// Logout
router.get('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.redirect('/');
  });
});

module.exports = router;
