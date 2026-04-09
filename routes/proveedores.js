const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');

const { registrarAuditoria } = require('../servicios/auditService');

const router = express.Router();

router.use(verifyToken);

// ==============================
// Validaciones
// ==============================
const validateProveedor = [
  body('Nombre_Proveedor').notEmpty().withMessage('Nombre del proveedor es requerido'),
  body('Correo').optional().isEmail().withMessage('Correo no válido'),
  body('Telefono').optional().isLength({ min: 7 }).withMessage('Teléfono inválido')
];


// ==============================
// GET /api/proveedores
// ==============================
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Proveedor');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los proveedores' });
  }
});

router.get('/buscar', async (req, res) => {
  const { term } = req.query;
  
  if (!term) return res.json([]);

  try {
    const result = await pool.query(
      `SELECT * FROM Proveedor 
       WHERE LOWER(Nombre_Proveedor) LIKE LOWER($1) 
       ORDER BY Nombre_Proveedor ASC 
       LIMIT 20`,
      [`%${term}%`]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en buscador de proveedores:', error);
    res.status(500).json({ message: 'Error al buscar proveedores' });
  }
});

// ==============================
// GET /api/proveedores/:id
// ==============================
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM Proveedor WHERE ID_Proveedor = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener el proveedor' });
  }
});

router.get('/nombre/:nombre', async (req, res) => {
  const { nombre } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM Proveedor WHERE LOWER(Nombre_Proveedor) LIKE LOWER($1)',
      [`%${nombre}%`]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar proveedor por nombre' });
  }
});

// ==============================
// POST /api/proveedores
// ==============================
router.post('/', validateProveedor, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errores: errors.array() });
  }

  const { Nombre_Proveedor, Contacto, Telefono, Correo, Direccion, RFC } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO Proveedor 
        (Nombre_Proveedor, Contacto, Telefono, Correo, Direccion, RFC)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [Nombre_Proveedor, Contacto, Telefono, Correo, Direccion, RFC]
    );
    
    const nuevoProveedor = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: CREACIÓN DE PROVEEDOR
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'CREAR',
        recurso_afectado: 'proveedor',
        id_recurso_afectado: nuevoProveedor.id_proveedor, // En minúsculas porque pg devuelve las columnas así
        detalles_cambio: {
            mensaje: 'Se dio de alta un nuevo proveedor.',
            nombre_proveedor: nuevoProveedor.nombre_proveedor,
            rfc: nuevoProveedor.rfc
        },
        ip_address: req.ip
    });

    res.status(201).json(nuevoProveedor);
  } catch (error) {
    if (error.code === '23505') { 
      return res.status(400).json({ message: 'El nombre de este proveedor ya existe.' });
    }
    res.status(500).json({ message: 'Error al crear el proveedor' });
  }
});

// ==============================
// PUT /api/proveedores/nombre/:nombre
// ==============================
router.put('/nombre/:nombre', [
  body('Contacto').notEmpty().withMessage('Contacto es requerido'),
  body('Telefono').notEmpty().withMessage('Teléfono es requerido'),
  body('Correo').isEmail().withMessage('Correo válido es requerido'),
], async (req, res) => {
  const { nombre } = req.params;
  const { Contacto, Telefono, Correo } = req.body;

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errores: errors.array() });
  }

  try {
    const result = await pool.query(
      `UPDATE Proveedor SET 
        Contacto = $1, 
        Telefono = $2, 
        Correo = $3
       WHERE LOWER(Nombre_Proveedor) = LOWER($4)
       RETURNING *`,
      [Contacto, Telefono, Correo, nombre]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }

    const proveedorActualizado = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: EDICIÓN DE PROVEEDOR
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'proveedor',
        id_recurso_afectado: proveedorActualizado.id_proveedor,
        detalles_cambio: {
            mensaje: 'Se actualizaron los datos de contacto del proveedor.',
            datos_actualizados: { Contacto, Telefono, Correo }
        },
        ip_address: req.ip
    });

    res.json({ message: 'Proveedor actualizado', proveedor: proveedorActualizado });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el proveedor' });
  }
});

// ==============================
// DELETE /api/proveedores/nombre/:nombre
// ==============================
router.delete('/nombre/:nombre', async (req, res) => {
  const { nombre } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM Proveedor WHERE LOWER(Nombre_Proveedor) = LOWER($1) RETURNING *',
      [nombre]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }

    const proveedorEliminado = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: ELIMINACIÓN DE PROVEEDOR
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ELIMINAR',
        recurso_afectado: 'proveedor',
        id_recurso_afectado: proveedorEliminado.id_proveedor,
        detalles_cambio: {
            mensaje: 'Se eliminó un proveedor del catálogo.',
            nombre_proveedor: proveedorEliminado.nombre_proveedor
        },
        ip_address: req.ip
    });

    res.json({ message: 'Proveedor eliminado exitosamente', proveedor: proveedorEliminado });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar proveedor por nombre. Verifica si tiene compras asociadas.' });
  }
});

module.exports = router;