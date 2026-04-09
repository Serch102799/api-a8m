const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

const { registrarAuditoria } = require('../servicios/auditService');

const router = express.Router();


// 🔒 Obtener TODOS los empleados (Activos e Inactivos) para el panel Admin
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id_empleado, nombre, puesto, departamento, nombre_usuario, estado_cuenta, id_rol 
       FROM empleado 
       ORDER BY id_empleado ASC` 
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

// 🔒 Crear nuevo empleado
router.post('/', [
    verifyToken, 
    checkRole(['Admin', 'SuperUsuario']),
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

    const {
      Nombre,
      Puesto,
      Departamento,
      Nombre_Usuario,
      Contrasena_Hash, 
      ID_Rol 
    } = req.body;

    try {
      const hashedPassword = await bcrypt.hash(Contrasena_Hash, 10);

      const result = await pool.query(
        `INSERT INTO empleado 
          (nombre, puesto, departamento, nombre_usuario, contrasena_hash, estado_cuenta, id_rol)
         VALUES ($1, $2, $3, $4, $5, 'Activo', $6)
         RETURNING id_empleado, nombre, puesto, nombre_usuario, id_rol`,
        [
          Nombre,
          Puesto,
          Departamento,
          Nombre_Usuario,
          hashedPassword,
          ID_Rol
        ]
      );

      const nuevoEmpleado = result.rows[0];

      // 🛡️ REGISTRO DE AUDITORÍA: CREACIÓN DE USUARIO
      registrarAuditoria({
          id_usuario: req.user.id,
          tipo_accion: 'CREAR',
          recurso_afectado: 'empleado',
          id_recurso_afectado: nuevoEmpleado.id_empleado,
          detalles_cambio: {
              mensaje: 'Se dio de alta un nuevo usuario/empleado en el sistema.',
              nombre: nuevoEmpleado.nombre,
              nombre_usuario: nuevoEmpleado.nombre_usuario,
              id_rol_asignado: nuevoEmpleado.id_rol
          },
          ip_address: req.ip
      });

      res.status(201).json(nuevoEmpleado);
    } catch (error) {
      if (error.code === '23505') { 
        return res.status(400).json({ message: 'El nombre de usuario ya está en uso.' });
      }
      if (error.code === '23503') { 
        return res.status(400).json({ message: 'El rol seleccionado no es válido.' });
      }
      console.error("Error al crear empleado:", error);
      res.status(500).json({ message: 'Error al crear el empleado' });
    }
});

// 🔒 Actualizar Empleado
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
        const checkUser = await pool.query(
            'SELECT id_empleado FROM empleado WHERE lower(nombre_usuario) = lower($1) AND id_empleado != $2',
            [Nombre_Usuario, id]
        );

        if (checkUser.rows.length > 0) {
            return res.status(400).json({ message: 'El nombre de usuario ya está ocupado por otra persona.' });
        }

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

        // 🛡️ REGISTRO DE AUDITORÍA: ACTUALIZACIÓN DE USUARIO
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'empleado',
            id_recurso_afectado: id,
            detalles_cambio: {
                mensaje: 'Se actualizaron los datos o permisos de un empleado.',
                datos_nuevos: { Nombre, Puesto, Departamento, Nombre_Usuario, ID_Rol, Estado_Cuenta }
            },
            ip_address: req.ip
        });

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

    const empleadoModificado = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: CAMBIO DE ESTADO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'empleado',
        id_recurso_afectado: empleadoModificado.id_empleado,
        detalles_cambio: {
            mensaje: `Se cambió el estado de la cuenta a: ${Estado_Cuenta}.`,
            usuario_afectado: nombreUsuario
        },
        ip_address: req.ip
    });

    res.json({ message: 'Estado_Cuenta actualizado exitosamente', empleado: empleadoModificado });
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

    const empleadoEliminado = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: BAJA (Desactivación)
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ELIMINAR', // Soft Delete
        recurso_afectado: 'empleado',
        id_recurso_afectado: empleadoEliminado.id_empleado,
        detalles_cambio: {
            mensaje: 'Se desactivó la cuenta de un empleado.',
            usuario_desactivado: nombreUsuario
        },
        ip_address: req.ip
    });

    res.json({ message: 'Empleado desactivado exitosamente', empleado: empleadoEliminado });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar el empleado' });
  }
});

module.exports = router;