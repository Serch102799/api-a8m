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

    await client.query(
      `INSERT INTO movimiento_refaccion (refaccion_id, empleado_id, tipo_movimiento, cantidad, motivo)
       VALUES ($1, $2, $3, $4, $5)`,
      [refaccion_id, empleado_id, tipo_movimiento, cantidad, motivo]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Movimiento registrado (nota: el stock requiere ajuste por lotes)' });

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
      SELECT id_detalle, tabla_origen, estado, fecha, tipo, cantidad, origen_destino, solicitado_por FROM (
        -- ENTRADAS
        SELECT 
          de.id_detalle_entrada as id_detalle,
          'detalle_entrada' as tabla_origen,
          de.estado,
          ea.fecha_operacion as fecha, 
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
          ds.id_detalle_salida as id_detalle,
          'detalle_salida' as tabla_origen,
          ds.estado,
          sa.fecha_operacion as fecha, 
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

// =======================================================
// CANCELAR MOVIMIENTO (DEVOLUCIÓN O ANULACIÓN)
// =======================================================
router.post('/cancelar', async (req, res) => {
  const { id_detalle, tabla_origen } = req.body;

  if (!id_detalle || !tabla_origen) {
    return res.status(400).json({ message: 'Faltan parámetros requeridos.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (tabla_origen === 'detalle_salida') {
      // 1. Obtener la información del detalle de salida
      const detalleRes = await client.query(
        'SELECT id_refaccion, cantidad_despachada, estado, id_lote FROM detalle_salida WHERE id_detalle_salida = $1 FOR UPDATE',
        [id_detalle]
      );

      if (detalleRes.rows.length === 0) {
        throw new Error('No se encontró el detalle de la salida.');
      }

      const detalle = detalleRes.rows[0];

      if (detalle.estado === 'Cancelado') {
        throw new Error('Este movimiento ya ha sido cancelado.');
      }

      // 2. Cambiar estado a 'Cancelado'
      await client.query(
        'UPDATE detalle_salida SET estado = $1 WHERE id_detalle_salida = $2',
        ['Cancelado', id_detalle]
      );

      // 3. Devolver stock al lote
      if (detalle.id_lote) {
        await client.query(
          'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible + $1 WHERE id_lote = $2',
          [detalle.cantidad_despachada, detalle.id_lote]
        );
      }

    } else if (tabla_origen === 'detalle_entrada') {
      // 1. Obtener la información del detalle de entrada
      const detalleRes = await client.query(
        'SELECT id_refaccion, cantidad_recibida, estado FROM detalle_entrada WHERE id_detalle_entrada = $1 FOR UPDATE',
        [id_detalle]
      );

      if (detalleRes.rows.length === 0) {
        throw new Error('No se encontró el detalle de la entrada.');
      }

      const detalle = detalleRes.rows[0];

      if (detalle.estado === 'Cancelado') {
        throw new Error('Este movimiento ya ha sido cancelado.');
      }

      // Verificar si hay stock suficiente para cancelar la entrada en el lote correspondiente
      const loteRes = await client.query(
        'SELECT id_lote, cantidad_disponible FROM lote_refaccion WHERE id_detalle_entrada = $1 FOR UPDATE',
        [id_detalle]
      );

      if (loteRes.rows.length > 0) {
        const lote = loteRes.rows[0];
        if (lote.cantidad_disponible < detalle.cantidad_recibida) {
          throw new Error('No se puede cancelar la entrada porque ya se ha utilizado parte del stock ingresado en este lote.');
        }

        // Restar stock al lote
        await client.query(
          'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2',
          [detalle.cantidad_recibida, lote.id_lote]
        );
      }

      // 2. Cambiar estado a 'Cancelado'
      await client.query(
        'UPDATE detalle_entrada SET estado = $1 WHERE id_detalle_entrada = $2',
        ['Cancelado', id_detalle]
      );
    } else {
      throw new Error('Tabla de origen no válida.');
    }

    await client.query('COMMIT');
    res.json({ message: 'Movimiento cancelado exitosamente, y el inventario ha sido ajustado.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error al cancelar movimiento:', error);
    res.status(400).json({ message: error.message || 'Error al procesar la cancelación.' });
  } finally {
    client.release();
  }
});

module.exports = router;
