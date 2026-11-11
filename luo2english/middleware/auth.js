// Authentication middleware
const requireAuth = (req, res, next) => {
  if (!req.session.user_id) {
    return res.redirect('/auth/login');
  }
  next();
};

// Admin-only middleware
const requireAdmin = (req, res, next) => {
  if (!req.session.user_id) {
    return res.redirect('/auth/login');
  }
  if (req.session.role !== 'admin') {
    return res.status(403).render('error', {
      message: 'Access denied. Admin privileges required.'
    });
  }
  next();
};

// Attach user info to res.locals for all views
const attachUser = (req, res, next) => {
  res.locals.user = req.session.user_id ? {
    id: req.session.user_id,
    username: req.session.username,
    role: req.session.role
  } : null;
  next();
};

const db = require('../db/postgres');

const validateSession = async (req, res, next) => {
  if (!req.session.user_id) return next();
  const { rows } = await db.query('SELECT username, role FROM users WHERE id = $1', [req.session.user_id]);
  const account = rows[0];
  if (!account) {
    return req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('connect.sid');
      res.redirect('/auth/login');
    });
  }
  req.session.username = account.username;
  req.session.role = account.role;
  next();
};

module.exports = {
  requireAuth,
  requireAdmin,
  attachUser,
  validateSession
};
