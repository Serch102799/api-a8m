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
    const historialPromise = pool.query(
      `SELECT fecha, kilometraje, tipo_item, nombre, marca, cantidad, solicitado_por, costo_unitario, costo_total
       FROM (
          -- 1. REFACCIONES
          SELECT 
            sa.fecha_operacion as fecha,
            sa.kilometraje_autobus as kilometraje,
            'Refacción' as tipo_item,
            r.nombre,
            r.marca,
            (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as cantidad,
            e.nombre as solicitado_por,
            COALESCE(l.costo_unitario_final, 0) as costo_unitario,
            ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * COALESCE(l.costo_unitario_final, 0)) as costo_total
          FROM detalle_salida ds
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
          JOIN lote_refaccion l ON ds.id_lote = l.id_lote
          JOIN empleado e ON sa.solicitado_por_id = e.id_empleado
          WHERE sa.id_autobus = $1

          UNION ALL

          -- 2. INSUMOS
          SELECT
            sa.fecha_operacion as fecha,
            sa.kilometraje_autobus as kilometraje,
            'Insumo' as tipo_item,
            i.nombre,
            i.marca,
            (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) as cantidad,
            e.nombre as solicitado_por,
            COALESCE(dsi.costo_al_momento, 0) as costo_unitario,
            ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * COALESCE(dsi.costo_al_momento, 0)) as costo_total
          FROM detalle_salida_insumo dsi
          JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
          JOIN insumo i ON dsi.id_insumo = i.id_insumo
          JOIN empleado e ON sa.solicitado_por_id = e.id_empleado
          WHERE sa.id_autobus = $1

          UNION ALL

          -- 3. SERVICIOS EXTERNOS
          SELECT
            se.fecha_servicio as fecha,
            se.kilometraje_autobus as kilometraje,
            'Serv. Externo' as tipo_item,
            se.descripcion as nombre,
            COALESCE(p.nombre_proveedor, 'Taller Externo') as marca,
            1 as cantidad,
            e.nombre as solicitado_por,
            se.costo_total as costo_unitario,
            se.costo_total as costo_total
          FROM servicio_externo se
          LEFT JOIN proveedor p ON se.id_proveedor = p.id_proveedor
          JOIN empleado e ON se.registrado_por_id = e.id_empleado
          WHERE se.id_autobus = $1 AND se.estatus = 'Activo'
       ) as movimientos
       ORDER BY fecha DESC`,
      [idAutobus]
    );

    const costoTotalPromise = pool.query(
      `SELECT COALESCE(SUM(costo_total), 0) as costo_total FROM (
          -- Costos de REFACCIONES 
          SELECT 
            SUM((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total
          FROM detalle_salida ds
          JOIN lote_refaccion l ON ds.id_lote = l.id_lote
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          WHERE sa.id_autobus = $1

          UNION ALL

          -- Costos de INSUMOS
          SELECT 
            SUM((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total
          FROM detalle_salida_insumo dsi
          JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
          WHERE sa.id_autobus = $1

          UNION ALL

          -- Costos de SERVICIOS EXTERNOS
          SELECT 
            SUM(costo_total) as costo_total
          FROM servicio_externo
          WHERE id_autobus = $1 AND estatus = 'Activo'
      ) as costos`,
      [idAutobus]
    );

    const [historialResult, costoTotalResult] = await Promise.all([
      historialPromise,
      costoTotalPromise,
    ]);
    
    // Aproveché para sanear bien el formateo de los floats
    const historialFormateado = historialResult.rows.map(item => ({
        ...item,
        costo_unitario: parseFloat(item.costo_unitario || 0),
        costo_total: parseFloat(item.costo_total || 0)
    }));

    res.json({
      historial: historialFormateado,
      costoTotal: parseFloat(costoTotalResult.rows[0].costo_total || 0),
    });

  } catch (error) {
    console.error('Error al obtener historial del autobús:', error);
    res.status(500).json({ message: 'Error en el servidor al cargar historial' });
  }
});

module.exports = router;