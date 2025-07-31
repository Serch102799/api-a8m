const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Empleados
 *   description: Gestión de empleados
 */

// 🔒 Obtener todos los empleados activos
router.get('/', verifyToken, async (req, res) => {
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

// 🔒 Obtener un empleado por nombre de usuario
router.get('/usuario/:nombreUsuario', verifyToken, async (req, res) => {
  const { nombreUsuario } = req.params;
  try {
    const result = await pool.query(
      'SELECT id_empleado, nombre, puesto, departamento, nombre_usuario, estado_cuenta, rol FROM empleado WHERE lower(nombre_usuario) = lower($1)',
      [nombreUsuario]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Empleado no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener el empleado' });
  }
});

// 🔓 Crear nuevo empleado (NO requiere token)
router.post('/', [
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

// 🔒 Actualizar estado de cuenta (requiere Admin)
router.put('/usuario/:nombreUsuario', verifyToken, checkRole(['Admin']), async (req, res) => {
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

// 🔒 Desactivar empleado (requiere Admin)
router.delete('/usuario/:nombreUsuario', verifyToken, checkRole(['Admin']), async (req, res) => {
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

    res.json({ message: 'Empleado desactivado exitosamente', empleado: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar el empleado' });
  }
});

module.exports = router;
