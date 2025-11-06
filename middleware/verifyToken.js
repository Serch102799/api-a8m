const jwt = require('jsonwebtoken');
const pool = require('../db'); // <-- 1. IMPORTANTE: Ajusta la ruta a tu archivo de conexión BD
require('dotenv').config();

/**
 * Middleware para verificar un token JWT.
 * * 1. Verifica la firma y expiración del token (estándar JWT).
 * 2. VERIFICA EN LA BD que la sesión (token) esté registrada y 'activa'.
 * Esto permite la revocación de tokens (forzar cierre de sesión).
 */
async function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (!token) {
    return res.status(403).json({ message: 'No se proveyó un token' });
  }

  try {
    // 2. Usamos try...catch para manejar la verificación
    // jwt.verify (sin callback) lanza un error si es inválido
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // 3. ¡NUEVO PASO! Verificar contra la base de datos
    const querySesion = `
      SELECT id_sesion 
      FROM sesiones_activas 
      WHERE token_jwt = $1 
        AND id_usuario = $2 
        AND estado = 'activo'
    `;
    
    // Usamos payload.id (que pusimos en el login)
    const result = await pool.query(querySesion, [token, payload.id]);

    // 4. Si no encontramos la sesión (o no está 'activa'), la rechazamos
    if (result.rows.length === 0) {
      return res.status(401).json({ 
        message: 'Sesión no válida. Por favor, inicie sesión de nuevo.' 
      });
    }

    // 5. ¡ÉXITO! El token es válido y la sesión está activa
    req.user = payload; // Guardamos los datos del usuario en el objeto request
    next(); // Continuamos a la ruta solicitada

  } catch (err) {
    // 6. Manejo de errores (token expirado, firma incorrecta, etc.)
    
    // Si el token ya expiró según JWT
    if (err.name === 'TokenExpiredError') {
      
      // Opcional: Limpiar este token de la BD
      // await pool.query("UPDATE sesiones_activas SET estado = 'expirado' WHERE token_jwt = $1", [token]);
      
      return res.status(401).json({ message: 'Token expirado' });
    }
    
    // Para otros errores (firma inválida, etc.)
    console.error('Error en verifyToken:', err.message);
    return res.status(401).json({ message: 'Token no válido' });
  }
}

module.exports = verifyToken;