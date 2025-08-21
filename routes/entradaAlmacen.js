const express = require('express');
const pool = require('../db');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: EntradasAlmacen
 *   description: Gestión de entradas al almacén
 */

/**
 * @swagger
 * /api/entradas:
 *   get:
 *     summary: Obtener todas las entradas al almacén
 *     tags: [EntradasAlmacen]
 *     responses:
 *       200:
 *         description: Lista de entradas
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ea.*, p.Nombre_Proveedor, e.Nombre AS Nombre_Empleado
      FROM Entrada_Almacen ea
      LEFT JOIN Proveedor p ON ea.ID_Proveedor = p.ID_Proveedor
      LEFT JOIN Empleado e ON ea.Recibido_Por_ID = e.ID_Empleado
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener entradas', error });
  }
});

/**
 * @swagger
 * /api/entradas:
 *   post:
 *     summary: Crear una nueva entrada
 *     tags: [EntradasAlmacen]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ID_Proveedor
 *               - Recibido_Por_ID
 *             properties:
 *               ID_Proveedor:
 *                 type: integer
 *               Numero_Factura_Proveedor:
 *                 type: string
 *               Observaciones:
 *                 type: string
 *               Recibido_Por_ID:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Entrada creada
 */
router.post('/', async (req, res) => {
  const { ID_Proveedor, Factura_Proveedor, Vale_Interno, Observaciones, Recibido_Por_ID,Razon_Social  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO Entrada_Almacen 
        (ID_Proveedor, Factura_Proveedor,Vale_Interno, Observaciones, Recibido_Por_ID,Razon_Social ) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [ID_Proveedor, Factura_Proveedor, Vale_Interno, Observaciones, Recibido_Por_ID,Razon_Social ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear entrada', error });
  }
});

/**
 * @swagger
 * /api/entradas/proveedor/{id}:
 *   get:
 *     summary: Obtener entradas por ID de proveedor
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Entradas del proveedor
 */
router.get('/proveedor/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM Entrada_Almacen WHERE ID_Proveedor = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar entradas por proveedor', error });
  }
});

/**
 * @swagger
 * /api/entradas/empleado/{id}:
 *   get:
 *     summary: Obtener entradas por ID de empleado que recibió
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Entradas recibidas por el empleado
 */
router.get('/empleado/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM Entrada_Almacen WHERE Recibido_Por_ID = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar entradas por empleado', error });
  }
});

/**
 * @swagger
 * /api/entradas/{id}:
 *   put:
 *     summary: Actualizar entrada por ID
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               Numero_Factura_Proveedor:
 *                 type: string
 *               Observaciones:
 *                 type: string
 *     responses:
 *       200:
 *         description: Entrada actualizada
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { Numero_Factura_Proveedor, Observaciones } = req.body;

  try {
    const result = await pool.query(
      `UPDATE Entrada_Almacen SET 
        Numero_Factura_Proveedor = $1,
        Observaciones = $2
       WHERE ID_Entrada = $3
       RETURNING *`,
      [Numero_Factura_Proveedor, Observaciones, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entrada no encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar entrada', error });
  }
});

/**
 * @swagger
 * /api/entradas/{id}:
 *   delete:
 *     summary: Eliminar entrada por ID
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *     responses:
 *       200:
 *         description: Entrada eliminada
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM Entrada_Almacen WHERE ID_Entrada = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entrada no encontrada' });
    }

    res.json({ message: 'Entrada eliminada', entrada: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar entrada', error });
  }
});

module.exports = router;
