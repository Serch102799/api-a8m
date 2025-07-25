const express = require('express');
const pool = require('../db');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: DetalleSalida
 *   description: Gestión de detalles de salidas de almacén
 */

/**
 * @swagger
 * /api/detalleSalida:
 *   get:
 *     summary: Obtener todos los detalles de salida
 *     tags: [DetalleSalida]
 *     responses:
 *       200:
 *         description: Lista de detalles de salida
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Detalle_Salida');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener detalles de salida:', error);
    res.status(500).json({ message: 'Error al obtener detalles de salida' });
  }
});

/**
 * @swagger
 * /api/detalleSalida/{idSalida}:
 *   get:
 *     summary: Obtener detalles de salida por ID_Salida
 *     tags: [DetalleSalida]
 *     parameters:
 *       - in: path
 *         name: idSalida
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID de la salida para filtrar detalles
 *     responses:
 *       200:
 *         description: Lista de detalles de salida por ID_Salida
 */
router.get('/salida/:idSalida', async (req, res) => {
  const { idSalida } = req.params;
  try {
    const result = await pool.query(
      `SELECT ds.*, r.nombre as nombre_refaccion, r.marca
       FROM detalle_salida ds
       JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
       WHERE ds.id_salida = $1`, 
      [idSalida]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener detalles por salida:', error);
    res.status(500).json({ message: 'Error al obtener detalles de salida' });
  }
});

/**
 * @swagger
 * tags:
 *   name: DetalleSalida
 *   description: Gestión del detalle de salidas de refacciones
 */

/**
 * @swagger
 * /api/detalle-salida:
 *   post:
 *     summary: Registrar una nueva salida de refacción
 *     tags: [DetalleSalida]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ID_Salida
 *               - ID_Refaccion
 *               - Cantidad_Despachada
 *             properties:
 *               ID_Salida:
 *                 type: integer
 *                 example: 10
 *               ID_Refaccion:
 *                 type: integer
 *                 example: 3
 *               Cantidad_Despachada:
 *                 type: integer
 *                 example: 5
 *     responses:
 *       201:
 *         description: Detalle de salida creado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id_salida:
 *                   type: integer
 *                   example: 10
 *                 id_refaccion:
 *                   type: integer
 *                   example: 3
 *                 cantidad_despachada:
 *                   type: integer
 *                   example: 5
 *       400:
 *         description: Datos inválidos (cantidad menor o igual a cero)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: La cantidad debe ser un número positivo.
 *       500:
 *         description: Error interno del servidor o stock insuficiente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Stock insuficiente. Disponible: 2, Solicitado: 5"

 */
// En routes/detalleSalida.js
router.post('/', async (req, res) => {
  // Se recibe el ID_Lote desde el frontend
  const { ID_Salida, ID_Refaccion, Cantidad_Despachada, ID_Lote } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verificar stock en el lote específico
    const loteResult = await client.query(
      'SELECT cantidad_disponible FROM lote_refaccion WHERE id_lote = $1 FOR UPDATE',
      [ID_Lote]
    );

    if (loteResult.rows.length === 0) {
      throw new Error('El lote seleccionado no existe.');
    }
    
    const stockDisponibleLote = loteResult.rows[0].cantidad_disponible;
    if (stockDisponibleLote < Cantidad_Despachada) {
      throw new Error(`Stock insuficiente en este lote. Disponible: ${stockDisponibleLote}`);
    }

    // 2. Restar stock del lote específico
    await client.query(
      'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2',
      [Cantidad_Despachada, ID_Lote]
    );
    
    // 3. Insertar el detalle de la salida, incluyendo el id_lote
    await client.query(
      `INSERT INTO detalle_salida (id_salida, id_refaccion, cantidad_despachada, id_lote)
       VALUES ($1, $2, $3, $4)`,
      [ID_Salida, ID_Refaccion, Cantidad_Despachada, ID_Lote]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Salida de lote registrada' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de salida de lote:', error);
    res.status(500).json({ message: error.message || 'Error al procesar la salida' });
  } finally {
    client.release();
  }
});
/**
 * @swagger
 * /api/detalleSalida/{id}:
 *   put:
 *     summary: Actualizar un detalle de salida
 *     tags: [DetalleSalida]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID del detalle de salida a actualizar
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               Cantidad_Despachada:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Detalle de salida actualizado
 *       404:
 *         description: Detalle no encontrado
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { Cantidad_Despachada } = req.body;
  try {
    const result = await pool.query(
      `UPDATE Detalle_Salida
       SET Cantidad_Despachada = $1
       WHERE ID_Detalle_Salida = $2
       RETURNING *`,
      [Cantidad_Despachada, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Detalle de salida no encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar detalle de salida:', error);
    res.status(500).json({ message: 'Error al actualizar detalle de salida' });
  }
});

/**
 * @swagger
 * /api/detalleSalida/{id}:
 *   delete:
 *     summary: Eliminar un detalle de salida
 *     tags: [DetalleSalida]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID del detalle de salida a eliminar
 *     responses:
 *       200:
 *         description: Detalle eliminado correctamente
 *       404:
 *         description: Detalle no encontrado
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM Detalle_Salida WHERE ID_Detalle_Salida = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Detalle de salida no encontrado' });
    }

    res.json({ message: 'Detalle eliminado exitosamente', detalle: result.rows[0] });
  } catch (error) {
    console.error('Error al eliminar detalle de salida:', error);
    res.status(500).json({ message: 'Error al eliminar detalle de salida' });
  }
});

router.post('/', async (req, res) => {
  const { ID_Salida, ID_Refaccion, Cantidad_Despachada } = req.body;

  // Validar que la cantidad sea positiva
  if (!Cantidad_Despachada || Cantidad_Despachada <= 0) {
    return res.status(400).json({ message: 'La cantidad debe ser mayor a cero.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Verificar si hay stock suficiente ANTES de restar
    const stockResult = await client.query('SELECT Stock_Actual FROM Refaccion WHERE ID_Refaccion = $1 FOR UPDATE', [ID_Refaccion]);
    if (stockResult.rows.length === 0) {
      throw new Error('La refacción no existe.');
    }
    const stockActual = stockResult.rows[0].stock_actual;
    if (stockActual < Cantidad_Despachada) {
      throw new Error(`Stock insuficiente. Disponible: ${stockActual}, Solicitado: ${Cantidad_Despachada}`);
    }

    // 2. Actualizar (restar) el stock en la tabla Refaccion
    await client.query(
      `UPDATE Refaccion
       SET Stock_Actual = Stock_Actual - $1
       WHERE ID_Refaccion = $2`,
      [Cantidad_Despachada, ID_Refaccion]
    );

    // 3. Insertar el registro en Detalle_Salida
    const detalleResult = await client.query(
      `INSERT INTO Detalle_Salida (ID_Salida, ID_Refaccion, Cantidad_Despachada)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [ID_Salida, ID_Refaccion, Cantidad_Despachada]
    );

    await client.query('COMMIT');
    res.status(201).json(detalleResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en la transacción de salida:', error);
    res.status(500).json({ message: error.message || 'Error al registrar la salida' });
  } finally {
    client.release();
  }
});

module.exports = router;
