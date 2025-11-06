const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db'); 
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

// Clave secreta para JWT (debería ir en variable de entorno)
const JWT_SECRET = 'clave_secreta_segura';

// ==============================
// POST /api/login
// ==============================
/**
 * @swagger
 * /api/login:
 *   post:
 *     summary: Iniciar sesión de empleado
 *     tags: [Login]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               Nombre_Usuario:
 *                 type: string
 *               Contrasena:
 *                 type: string
 *     responses:
 *       200:
 *         description: Inicio de sesión exitoso
 *       401:
 *         description: Credenciales incorrectas
 *       500:
 *         description: Error del servidor
 */
router.post(
  '/login',
  [
    body('Nombre_Usuario').notEmpty().withMessage('Nombre_Usuario es requerido'),
    body('Contrasena').notEmpty().withMessage('Contrasena es requerida')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errores: errors.array() });
    }

    const { Nombre_Usuario, Contrasena } = req.body;

    try {
      // 1. OBTENER AL EMPLEADO
      const result = await pool.query(
        `SELECT 
           e.id_empleado, e.nombre, e.puesto, e.nombre_usuario, 
           e.contrasena_hash,
           r.nombre_rol AS rol
         FROM 
           empleado e
         JOIN 
           roles r ON e.id_rol = r.id_rol
         WHERE 
           e.nombre_usuario = $1`,
        [Nombre_Usuario]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ message: 'Usuario no encontrado' });
      }

      const empleado = result.rows[0];

      // 2. VERIFICAR CONTRASEÑA
      const passwordMatch = await bcrypt.compare(Contrasena, empleado.contrasena_hash);
      if (!passwordMatch) {
        return res.status(401).json({ message: 'Contraseña incorrecta' });
      }

      // 3. DEFINIR TIEMPO Y PAYLOAD DEL TOKEN
      const duracionTokenHoras = 8;
      const tiempoExpMs = Date.now() + (duracionTokenHoras * 60 * 60 * 1000);
      const fechaExpiracion = new Date(tiempoExpMs);

      const payload = {
        id: empleado.id_empleado,
        nombre: empleado.nombre,
        rol: empleado.rol
      };
      
      // 4. FIRMAR EL TOKEN JWT
      const token = jwt.sign(
        payload, 
        process.env.JWT_SECRET,
        { expiresIn: `${duracionTokenHoras}h` } // Tu duración de 8h
      );

      // --- ¡NUEVO PASO! ---
      // 5. REGISTRAR LA SESIÓN EN LA BASE DE DATOS
      const ip = req.ip;
      const userAgent = req.headers['user-agent'];

      const querySesion = `
        INSERT INTO sesiones_activas 
          (id_usuario, token_jwt, user_agent, ip_address, fecha_expiracion_token, estado)
        VALUES 
          ($1, $2, $3, $4, $5, 'activo')
      `;
      
      // Ejecutamos el query para guardar la sesión.
      // No necesitamos 'await' si no queremos que el usuario espere,
      // pero es más seguro hacerlo con 'await' para asegurar que se guarde.
      await pool.query(querySesion, [
        empleado.id_empleado, 
        token, 
        userAgent, 
        ip, 
        fechaExpiracion
      ]);
      // --- FIN DEL NUEVO PASO ---

      // 6. ENVIAR RESPUESTA AL USUARIO
      res.status(200).json({
        message: 'Éxito al iniciar sesión',
        empleado: {
          id: empleado.id_empleado,
          nombre: empleado.nombre,
          puesto: empleado.puesto,
          rol: empleado.rol 
        },
        token
      });

    } catch (error) {
      console.error('Error al iniciar sesión:', error);
      res.status(500).json({ message: 'Error del servidor' });
    }
  }
);

/**
 * @swagger
 * /api/auth/change-password:
 *   put:
 *     summary: Cambia la contraseña del usuario actualmente logueado
 *     tags: [Autenticación]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 description: Contraseña actual del usuario
 *               newPassword:
 *                 type: string
 *                 description: Nueva contraseña (mínimo 6 caracteres)
 *     responses:
 *       200:
 *         description: Contraseña cambiada exitosamente
 *       400:
 *         description: Solicitud inválida (faltan datos o contraseña muy corta)
 *       401:
 *         description: La contraseña actual es incorrecta
 *       404:
 *         description: Usuario no encontrado
 *       500:
 *         description: Error en el servidor
 */

router.put('/change-password', verifyToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id; // Obtenido desde el token JWT gracias a verifyToken

  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ message: 'Proporciona la contraseña actual y una nueva de al menos 6 caracteres.' });
  }

  try {
    // 1. Obtener la contraseña actual del usuario
    const userResult = await pool.query(
      'SELECT contrasena_hash FROM empleado WHERE id_empleado = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado.' });
    }

    const currentHash = userResult.rows[0].contrasena_hash;

    // 2. Verificar la contraseña actual
    const isMatch = await bcrypt.compare(currentPassword, currentHash);
    if (!isMatch) {
      return res.status(401).json({ message: 'La contraseña actual es incorrecta.' });
    }

    // 3. Hashear la nueva contraseña
    const newHashedPassword = await bcrypt.hash(newPassword, 10);

    // 4. Actualizar en la BD
    await pool.query(
      'UPDATE empleado SET contrasena_hash = $1 WHERE id_empleado = $2',
      [newHashedPassword, userId]
    );

    res.json({ message: 'Contraseña actualizada exitosamente.' });

  } catch (error) {
    console.error('Error al cambiar contraseña:', error);
    res.status(500).json({ message: 'Error en el servidor.' });
  }
});

module.exports = router;
