const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Refacciones
 *   description: Gestión de refacciones
 */

/**
 * @swagger
 * /api/refacciones:
 *   get:
 *     summary: Obtener todas las refacciones
 *     tags: [Refacciones]
 *     responses:
 *       200:
 *         description: Lista de refacciones
 */
router.get('/', async (req, res) => {
  try {
    // La consulta ahora suma el stock de la tabla de lotes
    const result = await pool.query(`
      SELECT 
        r.*, 
        COALESCE(SUM(l.cantidad_disponible), 0) as stock_actual
      FROM refaccion r
      LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
      GROUP BY r.id_refaccion
      ORDER BY r.nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones' });
  }
});

/**
 * @swagger
 * /api/refacciones/nombre/{nombre}:
 *   get:
 *     summary: Obtener una refacción por nombre
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: nombre
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Refacción encontrada
 *       404:
 *         description: Refacción no encontrada
 */
router.get('/nombre/:nombre', async (req, res) => {
  try {
    const { nombre } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Nombre) = LOWER($1)', [nombre]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Refacción no encontrada' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la refacción' });
  }
});

/**
 * @swagger
 * /api/refacciones/categoria/{categoria}:
 *   get:
 *     summary: Obtener refacciones por categoría
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: categoria
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de refacciones por categoría
 */
router.get('/categoria/:categoria', async (req, res) => {
  try {
    const { categoria } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Categoria) = LOWER($1)', [categoria]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones por categoría' });
  }
});

/**
 * @swagger
 * /api/refacciones/marca/{marca}:
 *   get:
 *     summary: Obtener refacciones por marca
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: marca
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de refacciones por marca
 */
router.get('/marca/:marca', async (req, res) => {
  try {
    const { marca } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Marca) = LOWER($1)', [marca]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones por marca' });
  }
});

/**
 * @swagger
 * /api/refacciones:
 *   post:
 *     summary: Crear una nueva refacción
 *     tags: [Refacciones]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Nombre
 *             properties:
 *               Nombre:
 *                 type: string
 *               Numero_Parte:
 *                 type: string
 *               Categoria:
 *                 type: string
 *               Marca:
 *                 type: string
 *               Unidad_Medida:
 *                 type: string
 *               Ubicacion_Almacen:
 *                 type: string
 *               Stock_Actual:
 *                 type: integer
 *               Stock_Minimo:
 *                 type: integer
 *               Stock_Maximo:
 *                 type: integer
 *               Precio_Costo:
 *                 type: number
 *               Fecha_Ultima_Entrada:
 *                 type: string
 *                 format: date
 *               Proveedor_Principal_ID:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Refacción creada
 */
router.post('/', [verifyToken, checkRole(['Admin'])], async (req, res) => {
 
  const {
    Nombre,
    Numero_Parte,
    Categoria,
    Marca,
    Unidad_Medida,
    Ubicacion_Almacen,
    Stock_Minimo
  } = req.body;

  if (!Nombre || !Unidad_Medida) {
    return res.status(400).json({ message: 'Nombre y Unidad de Medida son requeridos.' });
  }

  try {
    // ✅ La consulta INSERT ya no incluye stock_actual ni precio_costo
    const result = await pool.query(
      `INSERT INTO refaccion (nombre, numero_parte, categoria, marca, unidad_medida, ubicacion_almacen, stock_minimo)
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      [Nombre, Numero_Parte, Categoria, Marca, Unidad_Medida, Ubicacion_Almacen, Stock_Minimo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // Error de valor duplicado
      return res.status(400).json({ message: 'Una refacción con ese nombre o número de parte ya existe.' });
    }
    console.error('Error al crear refacción:', error);
    res.status(500).json({ message: 'Error al crear la refacción' });
  }
});

/**
 * @swagger
 * /api/refacciones/nombre/{nombre}:
 *   put:
 *     summary: Editar una refacción por nombre 
 *     tags: [Refacciones]
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
 *             properties:
 *               Stock_Actual:
 *                 type: integer
 *               Stock_Minimo:
 *                 type: integer
 *               Stock_Maximo:
 *                 type: integer
 *               Precio_Costo:
 *                 type: number
 *     responses:
 *       200:
 *         description: Refacción actualizada
 */
router.put('/nombre/:nombre', async (req, res) => {
  const { nombre } = req.params;
  const {
    Stock_Actual,
    Stock_Minimo,
    Stock_Maximo,
    Precio_Costo,
  } = req.body;

  try {
    const result = await pool.query(
      `UPDATE Refaccion SET 
        Stock_Actual = COALESCE($1, Stock_Actual),
        Stock_Minimo = COALESCE($2, Stock_Minimo),
        Stock_Maximo = COALESCE($3, Stock_Maximo),
        Precio_Costo = COALESCE($4, Precio_Costo)
       WHERE LOWER(Nombre) = LOWER($5)
       RETURNING *`,
      [Stock_Actual, Stock_Minimo, Stock_Maximo, Precio_Costo, nombre]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Refacción no encontrada' });
    }

    res.json({ message: 'Refacción actualizada', refaccion: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar refacción' });
  }
});

/**
 * @swagger
 * /api/refacciones/nombre/{nombre}:
 *   delete:
 *     summary: Eliminar una refacción por nombre
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: nombre
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Refacción eliminada
 */
router.delete('/nombre/:nombre', async (req, res) => {
  const { nombre } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM Refaccion WHERE LOWER(Nombre) = LOWER($1) RETURNING *',
      [nombre]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Refacción no encontrada' });
    }

    res.json({ message: 'Refacción eliminada', refaccion: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar refacción' });
  }
});

module.exports = router;
