const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/postgres');
const router = express.Router();

// Helper: Validate email format
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// Helper: Validate password (min 8 chars)
const isValidPassword = (password) => typeof password === 'string' && password.length >= 8 && Buffer.byteLength(password) <= 72;

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
    username: ''
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
      username
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
      username
    });
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
