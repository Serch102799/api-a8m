const express = require('express');
const pool = require('../db');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   - name: DetalleEntrada
 *     description: Gestión de detalles de entrada de almacén
 */

/**
 * @swagger
 * /api/detalle-entrada:
 *   get:
 *     summary: Obtener todos los detalles de entrada
 *     tags: [DetalleEntrada]
 *     responses:
 *       200:
 *         description: Lista de todos los detalles de entrada
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM detalle_entrada');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los detalles de entrada' });
  }
});

/**
 * @swagger
 * /api/detalle-entrada/{idEntrada}:
 *   get:
 *     summary: Obtener todos los detalles de una entrada específica
 *     tags: [DetalleEntrada]
 *     parameters:
 *       - in: path
 *         name: idEntrada
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la entrada de almacén
 *     responses:
 *       200:
 *         description: Lista de detalles para la entrada solicitada
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_detalle_entrada:
 *                     type: integer
 *                   id_entrada:
 *                     type: integer
 *                   id_refaccion:
 *                     type: integer
 *                   cantidad:
 *                     type: integer
 *                   precio_unitario:
 *                     type: number
 *                   nombre_refaccion:
 *                     type: string
 */
router.get('/:idEntrada', async (req, res) => {
  const { idEntrada } = req.params;
  try {
    const result = await pool.query(
      `SELECT de.*, r.nombre as nombre_refaccion, r.marca 
       FROM detalle_entrada de
       JOIN refaccion r ON de.id_refaccion = r.id_refaccion
       WHERE de.id_entrada = $1`,
      [idEntrada]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los detalles de la entrada' });
  }
});

/**
 * @swagger
 * /api/detalle-entrada:
 *   post:
 *     summary: Registrar detalle de entrada y actualizar stock y costo promedio de una refacción
 *     description: Inserta un nuevo registro de detalle de entrada y actualiza el stock actual y el costo promedio ponderado de la refacción correspondiente.
 *     tags:
 *       - DetalleEntrada
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ID_Entrada
 *               - ID_Refaccion
 *               - Cantidad_Recibida
 *               - Costo_Unitario_Entrada
 *             properties:
 *               ID_Entrada:
 *                 type: integer
 *                 example: 5
 *               ID_Refaccion:
 *                 type: integer
 *                 example: 12
 *               Cantidad_Recibida:
 *                 type: integer
 *                 minimum: 1
 *                 example: 100
 *               Costo_Unitario_Entrada:
 *                 type: number
 *                 format: float
 *                 minimum: 0
 *                 example: 23.75
 *               Fecha_Caducidad:
 *                 type: string
 *                 format: date
 *                 example: "2025-12-31"
 *     responses:
 *       201:
 *         description: Detalle de entrada creado exitosamente y stock actualizado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id_detalle:
 *                   type: integer
 *                   example: 21
 *                 id_entrada:
 *                   type: integer
 *                   example: 5
 *                 id_refaccion:
 *                   type: integer
 *                   example: 12
 *                 cantidad_recibida:
 *                   type: integer
 *                   example: 100
 *                 costo_unitario_entrada:
 *                   type: number
 *                   format: float
 *                   example: 23.75
 *                 fecha_caducidad:
 *                   type: string
 *                   format: date
 *                   example: "2025-12-31"
 *       400:
 *         description: Datos inválidos - cantidad o costo incorrectos
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "La cantidad y el costo deben ser valores válidos."
 *       500:
 *         description: Error interno del servidor al insertar detalle o actualizar refacción
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Error al procesar la entrada"
 */

router.post('/', async (req, res) => {
  const { ID_Entrada, ID_Refaccion, Cantidad_Recibida, Costo_Unitario_Entrada } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Insertar el detalle de la entrada como antes
    const detalleResult = await client.query(
      `INSERT INTO detalle_entrada (id_entrada, id_refaccion, cantidad_recibida, costo_unitario_entrada)
       VALUES ($1, $2, $3, $4) RETURNING id_detalle_entrada`,
      [ID_Entrada, ID_Refaccion, Cantidad_Recibida, Costo_Unitario_Entrada]
    );
    const nuevoDetalleId = detalleResult.rows[0].id_detalle_entrada;

    // 2. Crear un nuevo lote para esta entrada
    await client.query(
      `INSERT INTO lote_refaccion (id_refaccion, id_detalle_entrada, cantidad_disponible, costo_unitario_compra)
       VALUES ($1, $2, $3, $4)`,
      [ID_Refaccion, nuevoDetalleId, Cantidad_Recibida, Costo_Unitario_Entrada]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Detalle de entrada y lote creados' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de entrada:', error);
    res.status(500).json({ message: error.message || 'Error al procesar la entrada' });
  } finally {
    client.release();
  }
});

module.exports = router;
