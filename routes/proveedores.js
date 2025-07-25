const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');

const router = express.Router();

// ==============================
// Validaciones
// ==============================
const validateProveedor = [
  body('Nombre_Proveedor').notEmpty().withMessage('Nombre del proveedor es requerido'),
  body('Correo').optional().isEmail().withMessage('Correo no válido'),
  body('Telefono').optional().isLength({ min: 7 }).withMessage('Teléfono inválido')
];

// ==============================
// Swagger tags
// ==============================
/**
 * @swagger
 * tags:
 *   name: Proveedores
 *   description: Gestión de proveedores
 */

// ==============================
// GET /api/proveedores
// ==============================
/**
 * @swagger
 * /api/proveedores:
 *   get:
 *     summary: Obtener todos los proveedores
 *     tags: [Proveedores]
 *     responses:
 *       200:
 *         description: Lista de proveedores
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Proveedor');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los proveedores' });
  }
});

// ==============================
// GET /api/proveedores/:id
// ==============================
/**
 * @swagger
 * /api/proveedores/{id}:
 *   get:
 *     summary: Obtener un proveedor por ID
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Proveedor encontrado
 *       404:
 *         description: Proveedor no encontrado
 */
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

/**
 * @swagger
 * /api/proveedores/nombre/{nombre}:
 *   get:
 *     summary: Buscar proveedor por nombre
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: nombre
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Proveedor encontrado
 *       404:
 *         description: Proveedor no encontrado
 */
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
/**
 * @swagger
 * /api/proveedores:
 *   post:
 *     summary: Crear un nuevo proveedor
 *     tags: [Proveedores]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Nombre_Proveedor
 *             properties:
 *               Nombre_Proveedor:
 *                 type: string
 *               Contacto:
 *                 type: string
 *               Telefono:
 *                 type: string
 *               Correo:
 *                 type: string
 *               Direccion:
 *                 type: string
 *               RFC:
 *                 type: string
 *     responses:
 *       201:
 *         description: Proveedor creado exitosamente
 *       400:
 *         description: Datos inválidos
 */
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
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { 
      return res.status(400).json({ message: 'El nombre de este proveedor ya existe.' });
    }
    res.status(500).json({ message: 'Error al crear el proveedor' });
  }
});

// ==============================
// PUT /api/proveedores/:id
// ==============================
/**
 * @swagger
 * /api/proveedores/nombre/{nombre}:
 *   put:
 *     summary: Actualizar contacto, teléfono y correo del proveedor por nombre
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: nombre
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
 *               - Contacto
 *               - Telefono
 *               - Correo
 *             properties:
 *               Contacto:
 *                 type: string
 *               Telefono:
 *                 type: string
 *               Correo:
 *                 type: string
 *     responses:
 *       200:
 *         description: Proveedor actualizado exitosamente
 *       404:
 *         description: Proveedor no encontrado
 */
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

    res.json({ message: 'Proveedor actualizado', proveedor: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el proveedor' });
  }
});



// ==============================
// DELETE /api/proveedores/:id
// ==============================
/**
 * @swagger
 * /api/proveedores/nombre/{nombre}:
 *   delete:
 *     summary: Eliminar proveedor por nombre
 *     tags: [Proveedores]
 *     parameters:
 *       - in: path
 *         name: nombre
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Proveedor eliminado exitosamente
 *       404:
 *         description: Proveedor no encontrado
 */
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

    res.json({ message: 'Proveedor eliminado exitosamente', proveedor: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar proveedor por nombre' });
  }
});


module.exports = router;
