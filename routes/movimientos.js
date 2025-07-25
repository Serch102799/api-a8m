const express = require('express');
const pool = require('../db');
const router = express.Router();

/**
 * @swagger
 * /api/movimientos:
 *   post:
 *     summary: Registra un movimiento de inventario simple (entrada o salida) y actualiza el stock
 *     tags: [Movimientos]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refaccion_id
 *               - empleado_id
 *               - tipo_movimiento
 *               - cantidad
 *             properties:
 *               refaccion_id:
 *                 type: integer
 *               empleado_id:
 *                 type: integer
 *               tipo_movimiento:
 *                 type: string
 *                 enum: [Entrada, Salida]
 *               cantidad:
 *                 type: integer
 *               motivo:
 *                 type: string
 *     responses:
 *       '201':
 *         description: Movimiento registrado y stock actualizado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Movimiento registrado exitosamente"
 *                 stock_actualizado:
 *                   type: integer
 *       '400':
 *         description: Datos inválidos o stock insuficiente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "El tipo de movimiento no es válido."
 *       '500':
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Stock insuficiente. Disponible: 2"
 */
router.post('/', async (req, res) => {
  const { refaccion_id, empleado_id, tipo_movimiento, cantidad, motivo } = req.body;

  if (!cantidad || cantidad <= 0) {
    return res.status(400).json({ message: 'La cantidad debe ser un número positivo.' });
  }
  if (!['Entrada', 'Salida'].includes(tipo_movimiento)) {
    return res.status(400).json({ message: 'El tipo de movimiento no es válido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let updatedStock;

    if (tipo_movimiento === 'Salida') {
      // Verificar stock antes de restar
      const stockResult = await client.query('SELECT stock_actual FROM refaccion WHERE id_refaccion = $1 FOR UPDATE', [refaccion_id]);
      if (stockResult.rows.length === 0) throw new Error('La refacción no existe.');
      
      const stockActual = stockResult.rows[0].stock_actual;
      if (stockActual < cantidad) throw new Error(`Stock insuficiente. Disponible: ${stockActual}`);
      
      // Restar stock
      const updateResult = await client.query(
        'UPDATE refaccion SET stock_actual = stock_actual - $1 WHERE id_refaccion = $2 RETURNING stock_actual',
        [cantidad, refaccion_id]
      );
      updatedStock = updateResult.rows[0].stock_actual;

    } else { // Si es 'Entrada'
      // Sumar stock
      const updateResult = await client.query(
        'UPDATE refaccion SET stock_actual = stock_actual + $1 WHERE id_refaccion = $2 RETURNING stock_actual',
        [cantidad, refaccion_id]
      );
      updatedStock = updateResult.rows[0].stock_actual;
    }

    // Insertar el registro del movimiento
    await client.query(
      `INSERT INTO movimiento_refaccion (refaccion_id, empleado_id, tipo_movimiento, cantidad, motivo)
       VALUES ($1, $2, $3, $4, $5)`,
      [refaccion_id, empleado_id, tipo_movimiento, cantidad, motivo]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Movimiento registrado exitosamente', stock_actualizado: updatedStock });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de movimiento:', error);
    res.status(500).json({ message: error.message || 'Error al registrar movimiento' });
  } finally {
    client.release();
  }
});
/**
 * @swagger
 * /api/movimientos/{idRefaccion}:
 *   get:
 *     summary: Obtiene el historial de movimientos para una refacción específica
 *     tags: [Movimientos]
 *     parameters:
 *       - in: path
 *         name: idRefaccion
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Una lista con el historial de entradas y salidas
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   fecha:
 *                     type: string
 *                     format: date
 *                     example: "2025-07-15"
 *                   tipo:
 *                     type: string
 *                     enum: [Entrada, Salida]
 *                     example: "Entrada"
 *                   cantidad:
 *                     type: integer
 *                     example: 10
 *                   origen_destino:
 *                     type: string
 *                     example: "Proveedor XYZ"       
 *       500:
 *         description: Error en el servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Error en el servidor"
 */

router.get('/:idRefaccion', async (req, res) => {
  const { idRefaccion } = req.params;

  try {
    const query = `
      SELECT fecha, tipo, cantidad, origen_destino, solicitado_por FROM (
        -- ENTRADAS
        SELECT 
          ea.fecha_entrada as fecha, 
          'Entrada' as tipo, 
          de.cantidad_recibida as cantidad, 
          p.nombre_proveedor as origen_destino,
          e.nombre as solicitado_por -- El empleado que recibió
        FROM detalle_entrada de
        JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
        JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
        JOIN empleado e ON ea.recibido_por_id = e.id_empleado
        WHERE de.id_refaccion = $1
        
        UNION ALL
        
        -- SALIDAS
        SELECT 
          sa.fecha_salida as fecha, 
          'Salida' as tipo, 
          ds.cantidad_despachada as cantidad, 
          ('Autobús #' || a.economico) as origen_destino,
          e.nombre as solicitado_por -- El empleado que solicitó
        FROM detalle_salida ds
        JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
        JOIN autobus a ON sa.id_autobus = a.id_autobus
        JOIN empleado e ON sa.solicitado_por_id = e.id_empleado
        WHERE ds.id_refaccion = $1
      ) as movimientos
      ORDER BY fecha DESC;
    `;

    const result = await pool.query(query, [idRefaccion]);
    res.json(result.rows);

  } catch (error) {
    console.error('Error al obtener historial de movimientos:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});


module.exports = router;
