const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

/**
 * @swagger
 * tags:
 *   - name: Roles
 *     description: Gestión de roles de usuario
 */

/**
 * @swagger
 * /api/roles:
 *   get:
 *     summary: Obtener una lista de todos los roles
 *     description: Retorna todos los roles registrados en el sistema.
 *     tags: [Roles]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de roles obtenida exitosamente.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_rol:
 *                     type: integer
 *                     description: ID único del rol
 *                     example: 1
 *                   nombre_rol:
 *                     type: string
 *                     description: Nombre del rol
 *                     example: Administrador
 *       401:
 *         description: Token no proporcionado o inválido.
 *       500:
 *         description: Error en el servidor.
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id_rol, nombre_rol FROM roles ORDER BY nombre_rol'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener roles:', error);
    res.status(500).json({ message: 'Error al obtener la lista de roles' });
  }
});

module.exports = router;