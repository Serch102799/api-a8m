const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const verifyToken = require('..//middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

const router = express.Router();

router.use(verifyToken);

/**
 * @swagger
 * tags:
 *   name: Empleados
 *   description: Gestión de empleados
 */

/**
 * @swagger
 * /api/empleados:
 *   get:
 *     security:
 *       - bearerAuth: []
 *     summary: Obtener todos los empleados activos
 *     tags: [Empleados]
 *     responses:
 *       200:
 *         description: Lista de empleados
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id_empleado, nombre, puesto, departamento, nombre_usuario, estado_cuenta, rol 
       FROM empleado WHERE estado_cuenta = 'Activo'`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los empleados' });
  }
});

/**
 * @swagger
 * /api/empleados/usuario/{nombreUsuario}:
 *   get:
 *     security:
 *       - bearerAuth: []
 *     summary: Obtener un empleado por nombre de usuario
 *     tags: [Empleados]
 *     parameters:
 *       - in: path
 *         name: nombreUsuario
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Empleado encontrado
 *       404:
 *         description: Empleado no encontrado
 */
router.get('/usuario/:nombreUsuario', async (req, res) => {
  const { nombreUsuario } = req.params;
  try {
    const result = await pool.query('SELECT id_empleado, nombre, puesto, departamento, nombre_usuario, estado_cuenta, rol FROM empleado WHERE lower(nombre_usuario) = lower($1)', [nombreUsuario]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Empleado no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener el empleado' });
  }
});

/**
 * @swagger
 * /api/empleados:
 *   post:
 *     security:
 *       - bearerAuth: []
 *     summary: Crear un nuevo empleado (Solo Admins)
 *     tags: [Empleados]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Nombre
 *               - Puesto
 *               - Departamento
 *               - Nombre_Usuario
 *               - Contrasena_Hash
 *             properties:
 *               Nombre:
 *                 type: string
 *               Puesto:
 *                 type: string
 *               Departamento:
 *                 type: string
 *               Nombre_Usuario:
 *                 type: string
 *               Contrasena_Hash:
 *                 type: string
 *               Estado_Cuenta:
 *                 type: string
 *               rol:
 *                 type: string
 *     responses:
 *       201:
 *         description: Empleado creado exitosamente
 */
router.post('/', /* Sin verifyToken ni checkRole temporalmente */ [
  body('Nombre').notEmpty().withMessage('Nombre es requerido'),
  body('Nombre_Usuario').notEmpty().withMessage('Nombre_Usuario es requerido'),
  body('Contrasena_Hash').notEmpty().withMessage('Contrasena es requerida'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errores: errors.array() });
  }

  const {
    Nombre,
    Puesto,
    Departamento,
    Nombre_Usuario,
    Contrasena_Hash,
    rol
  } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(Contrasena_Hash, 10);
    const result = await pool.query(
      `INSERT INTO empleado 
       (nombre, puesto, departamento, nombre_usuario, contrasena_hash, estado_cuenta, rol)
       VALUES ($1, $2, $3, $4, $5, 'Activo', $6)
       RETURNING id_empleado, nombre, puesto, rol`,
      [
        Nombre,
        Puesto,
        Departamento,
        Nombre_Usuario,
        hashedPassword,
        rol || 'Almacenista'
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ message: 'Nombre de usuario ya está en uso' });
    }
    console.error("Error al crear empleado:", error);
    res.status(500).json({ message: 'Error al crear el empleado' });
  }
});

/**
 * @swagger
 * /api/empleados/usuario/{nombreUsuario}:
 *   put:
 *     security:
 *       - bearerAuth: []
 *     summary: Actualizar estado de un empleado (Solo Admins)
 *     tags: [Empleados]
 *     parameters:
 *       - in: path
 *         name: nombreUsuario
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Estado_Cuenta
 *             properties:
 *               Estado_Cuenta:
 *                 type: string
 *     responses:
 *       200:
 *         description: Estado de Cuenta actualizado exitosamente
 */
router.put('/usuario/:nombreUsuario', checkRole(['Admin']), async (req, res) => {
  const { nombreUsuario } = req.params;
  const { Estado_Cuenta } = req.body;
  if (!Estado_Cuenta) {
    return res.status(400).json({ message: 'El campo Estado_Cuenta es obligatorio.' });
  }
  try {
    const result = await pool.query(
      `UPDATE empleado SET estado_cuenta = $1 WHERE lower(nombre_usuario) = lower($2) RETURNING *`,
      [Estado_Cuenta, nombreUsuario]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Empleado no encontrado' });
    }
    res.json({ message: 'Estado_Cuenta actualizado exitosamente', empleado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar Estado_Cuenta' });
  }
});

/**
 * @swagger
 * /api/empleados/usuario/{nombreUsuario}:
 *   delete:
 *     security:
 *       - bearerAuth: []
 *     summary:  Desactivar un empleado por nombre de usuario (Solo Admins)
 *     tags: [Empleados]
 *     parameters:
 *       - in: path
 *         name: nombreUsuario
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Empleado eliminado exitosamente
 */
router.delete('/usuario/:nombreUsuario', checkRole(['Admin']), async (req, res) => {
  const { nombreUsuario } = req.params;
  try {
    const result = await pool.query(
      `UPDATE empleado SET estado_cuenta = 'Inactivo' 
       WHERE lower(nombre_usuario) = lower($1) 
       RETURNING *`,
      [nombreUsuario]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Empleado no encontrado' });
    }
    // El mensaje ahora es más preciso
    res.json({ message: 'Empleado desactivado exitosamente', empleado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar el empleado' });
  }
});

module.exports = router;
