function flashMessages(req, res, next) {
  res.locals.flash = req.session.flash || null;
  if (req.session.flash) delete req.session.flash;
  next();
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { flashMessages, setFlash };
