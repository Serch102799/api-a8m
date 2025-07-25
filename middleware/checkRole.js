function checkRole(roles) {
  return function(req, res, next) {
    console.log('Verificando rol. Usuario en el token:', req.user);
    // req.user es añadido por el middleware verifyToken
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ message: 'Acceso denegado. No tienes los permisos necesarios.' });
    }
    next(); // El usuario tiene el rol correcto, puede continuar
  }
}

module.exports = checkRole;