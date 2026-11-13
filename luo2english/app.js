const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const db = require('./db/postgres');
const { sendPasswordResetEmail } = require('./lib/mailer');
const { attachUser, validateSession } = require('./middleware/auth');
const { flashMessages } = require('./middleware/flash');
const { securityHeaders, sameSiteRequestGuard } = require('./middleware/security');

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}
if (process.env.TRUST_PROXY === 'loopback') app.set('trust proxy', 'loopback');

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(securityHeaders);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(express.json({ limit: '16kb' }));
app.use(sameSiteRequestGuard);

// Session middleware
const sessionStore = new (require('connect-pg-simple')(session))({ pool: db, createTableIfMissing: true });
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-key',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
}));

app.use(validateSession);

// Attach user to locals
app.use(attachUser);
app.use(flashMessages);

// Routes
app.use('/', require('./routes/public'));
app.use('/auth', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/comments', require('./routes/comments'));

// Error handling
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', {
    user: req.session?.user_id ? { username: req.session.username, role: req.session.role } : null,
    message: err.message || 'Internal server error'
  });
});

// 404
app.use((req, res) => {
  res.status(404).render('error', {
    user: req.session?.user_id ? { username: req.session.username, role: req.session.role } : null,
    message: 'Page not found'
  });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, process.env.HOST, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
app.locals.db = db;
app.locals.sessionStore = sessionStore;
app.locals.sendPasswordResetEmail = sendPasswordResetEmail;
