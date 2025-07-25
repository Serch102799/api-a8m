const jwt = require('jsonwebtoken');
require('dotenv').config();

function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (!token) {
    return res.status(403).json({ message: 'No se proveyó un token' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ message: 'Token no válido o expirado' });
    }
    req.user = user; // Guardamos los datos del usuario en el objeto request
    next(); // El token es válido, continuamos a la ruta solicitada
  });
}

module.exports = verifyToken;