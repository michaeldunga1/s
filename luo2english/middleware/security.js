const isProduction = process.env.NODE_ENV === 'production';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "manifest-src 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  isProduction ? 'upgrade-insecure-requests' : ''
].filter(Boolean).join('; ');

const NO_INDEX_PREFIXES = ['/admin', '/auth', '/comments', '/profile'];
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function isNoIndex(path) {
  return NO_INDEX_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  if (isNoIndex(req.path)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function sameSiteRequestGuard(req, res, next) {
  if (!MUTATING_METHODS.has(req.method)) return next();
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
    return res.status(403).type('text/plain').send('Cross-site request blocked.');
  }
  next();
}

module.exports = { securityHeaders, sameSiteRequestGuard, CONTENT_SECURITY_POLICY };
