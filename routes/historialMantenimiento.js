const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);
/**
 * @swagger
 * /api/historial/{idAutobus}:
 *   get:
 *     summary: Obtiene el historial de mantenimiento y el costo total de refacciones usadas para un autobús
 *     description: Retorna una lista de refacciones utilizadas en un autobús específico, junto con el costo total calculado con base en la cantidad despachada y el precio de costo.
 *     tags:
 *       - HistorialMantenimiento
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idAutobus
 *         required: true
 *         description: ID del autobús
 *         schema:
 *           type: integer
 *           example: 12
 *     responses:
 *       200:
 *         description: Historial de refacciones y costo total obtenidos exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 historial:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       fecha_salida:
 *                         type: string
 *                         format: date
 *                         example: "2025-07-20"
 *                       kilometraje_autobus:
 *                         type: integer
 *                         example: 134500
 *                       nombre_refaccion:
 *                         type: string
 *                         example: "Bujía"
 *                       marca:
 *                         type: string
 *                         example: "NGK"
 *                       cantidad_despachada:
 *                         type: integer
 *                         example: 4
 *                       solicitado_por:
 *                         type: string
 *                         example: "Carlos Rodríguez"
 *                 costoTotal:
 *                   type: number
 *                   format: float
 *                   example: 1450.75
 *       401:
 *         description: No autorizado - Token inválido o ausente
 *       500:
 *         description: Error interno del servidor
 */

router.get('/:idAutobus', async (req, res) => {
  const { idAutobus } = req.params;

  try {
    // Consulta para obtener la lista de todos los movimientos (refacciones e insumos)
    const historialPromise = pool.query(
      `SELECT fecha, kilometraje, tipo_item, nombre, marca, cantidad, solicitado_por
       FROM (
          -- Movimientos de REFACCIONES
          SELECT 
            sa.fecha_salida as fecha,
            sa.kilometraje_autobus as kilometraje,
            'Refacción' as tipo_item,
            r.nombre,
            r.marca,
            ds.cantidad_despachada as cantidad,
            e.nombre as solicitado_por
          FROM detalle_salida ds
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
          JOIN empleado e ON sa.solicitado_por_id = e.id_empleado
          WHERE sa.id_autobus = $1

          UNION ALL

          -- Movimientos de INSUMOS
          SELECT
            sa.fecha_salida as fecha,
            sa.kilometraje_autobus as kilometraje,
            'Insumo' as tipo_item,
            i.nombre,
            i.marca,
            dsi.cantidad_usada as cantidad,
            e.nombre as solicitado_por
          FROM detalle_salida_insumo dsi
          JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
          JOIN insumo i ON dsi.id_insumo = i.id_insumo
          JOIN empleado e ON sa.solicitado_por_id = e.id_empleado
          WHERE sa.id_autobus = $1
       ) as movimientos
       ORDER BY fecha DESC;`,
      [idAutobus]
    );

    // Consulta para calcular el COSTO TOTAL (sumando refacciones e insumos)
    const costoTotalPromise = pool.query(
      `SELECT COALESCE(SUM(costo_total), 0) as costo_total FROM (
          -- Costos de REFACCIONES (desde el lote)
          SELECT SUM(ds.cantidad_despachada * l.costo_unitario_final) as costo_total
          FROM detalle_salida ds
          JOIN lote_refaccion l ON ds.id_lote = l.id_lote
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          WHERE sa.id_autobus = $1

          UNION ALL

          -- Costos de INSUMOS (desde el detalle del insumo)
          SELECT SUM(dsi.cantidad_usada * dsi.costo_al_momento) as costo_total
          FROM detalle_salida_insumo dsi
          JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
          WHERE sa.id_autobus = $1
      ) as costos`,
      [idAutobus]
    );

    const [historialResult, costoTotalResult] = await Promise.all([
      historialPromise,
      costoTotalPromise,
    ]);
    
    res.json({
      historial: historialResult.rows,
      costoTotal: parseFloat(costoTotalResult.rows[0].costo_total || 0),
    });

  } catch (error) {
    console.error('Error al obtener historial de movimientos:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

module.exports = router;