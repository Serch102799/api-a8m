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
// 🔒 Obtener TODOS los empleados (Activos e Inactivos) para el panel Admin
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id_empleado, nombre, puesto, departamento, nombre_usuario, estado_cuenta, id_rol 
       FROM empleado 
       ORDER BY id_empleado ASC` // Quitamos el WHERE estado_cuenta = 'Activo'
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
      'SELECT id_empleado, nombre, puesto, departamento, nombre_usuario, estado_cuenta, id_rol FROM empleado WHERE lower(nombre_usuario) = lower($1)',
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
    verifyToken, 
    checkRole(['Admin', 'SuperUsuario']),
    // CAMBIO: La validación ahora espera la contraseña en texto plano y el ID del rol.
    body('Nombre').notEmpty().withMessage('El nombre es requerido'),
    body('Nombre_Usuario').notEmpty().withMessage('El nombre de usuario es requerido'),
    body('Contrasena_Hash').notEmpty().withMessage('La contraseña es requerida'),
    body('ID_Rol').isNumeric().withMessage('El rol es requerido')
  ], 
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errores: errors.array() });
    }

    // CAMBIO: Se reciben 'Contrasena' (no hash) y 'ID_Rol' (no el nombre del rol).
    const {
      Nombre,
      Puesto,
      Departamento,
      Nombre_Usuario,
      Contrasena_Hash, 
      ID_Rol 
    } = req.body;

    try {
      // El backend se encarga de hacer el hash de la contraseña, no el frontend.
      const hashedPassword = await bcrypt.hash(Contrasena_Hash, 10);

      const result = await pool.query(
        // CAMBIO: La consulta INSERT ahora usa 'id_rol' y nombres de columna en minúsculas.
        `INSERT INTO empleado 
          (nombre, puesto, departamento, nombre_usuario, contrasena_hash, estado_cuenta, id_rol)
         VALUES ($1, $2, $3, $4, $5, 'Activo', $6)
         RETURNING id_empleado, nombre, puesto, id_rol`,
        [
          Nombre,
          Puesto,
          Departamento,
          Nombre_Usuario,
          hashedPassword,
          ID_Rol
        ]
      );
      res.status(201).json(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') { // Error de duplicado
        return res.status(400).json({ message: 'El nombre de usuario ya está en uso.' });
      }
      if (error.code === '23503') { // Error de llave foránea
        return res.status(400).json({ message: 'El rol seleccionado no es válido.' });
      }
      console.error("Error al crear empleado:", error);
      res.status(500).json({ message: 'Error al crear el empleado' });
    }
});
router.put('/:id', [
    verifyToken,
    checkRole(['Admin', 'SuperUsuario']),
    body('Nombre').notEmpty().withMessage('El nombre es requerido'),
    body('Nombre_Usuario').notEmpty().withMessage('El usuario es requerido'),
    body('ID_Rol').isNumeric().withMessage('El rol es requerido')
], async (req, res) => {
    
    const { id } = req.params;
    const { Nombre, Puesto, Departamento, Nombre_Usuario, ID_Rol, Estado_Cuenta } = req.body;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errores: errors.array() });
    }

    try {
        // Verificar si el nombre de usuario ya existe en OTRO empleado (para evitar duplicados al editar)
        const checkUser = await pool.query(
            'SELECT id_empleado FROM empleado WHERE lower(nombre_usuario) = lower($1) AND id_empleado != $2',
            [Nombre_Usuario, id]
        );

        if (checkUser.rows.length > 0) {
            return res.status(400).json({ message: 'El nombre de usuario ya está ocupado por otra persona.' });
        }

        // Ejecutar la actualización
        const result = await pool.query(
            `UPDATE empleado 
             SET nombre = $1, 
                 puesto = $2, 
                 departamento = $3, 
                 nombre_usuario = $4, 
                 id_rol = $5, 
                 estado_cuenta = $6
             WHERE id_empleado = $7
             RETURNING *`,
            [Nombre, Puesto, Departamento, Nombre_Usuario, ID_Rol, Estado_Cuenta, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Empleado no encontrado.' });
        }

        res.json({ message: 'Empleado actualizado correctamente.', empleado: result.rows[0] });

    } catch (error) {
        console.error('Error al actualizar empleado:', error);
        res.status(500).json({ message: 'Error interno al actualizar.' });
    }
});
// 🔒 Actualizar estado de cuenta (requiere Admin)
router.put('/usuario/:nombreUsuario', verifyToken, checkRole(['Admin', 'SuperUsuario']), async (req, res) => {
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
router.delete('/usuario/:nombreUsuario', verifyToken, checkRole(['Admin', 'SuperUsuario']), async (req, res) => {
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
