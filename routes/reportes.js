
const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);

/**
 * @swagger
 * /api/reportes/{tipoReporte}:
 *   get:
 *     summary: Genera diferentes tipos de reportes de refacciones
 *     description: Genera reportes según el tipo solicitado. Algunos tipos requieren rango de fechas.
 *     tags: [Reportes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tipoReporte
 *         required: true
 *         schema:
 *           type: string
 *           enum: [stock-bajo, mas-utilizadas, menos-utilizadas, costo-por-autobus]
 *         description: Tipo de reporte a generar
 *       - in: query
 *         name: fechaInicio
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Fecha de inicio del periodo (requerida para ciertos reportes)
 *       - in: query
 *         name: fechaFin
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Fecha de fin del periodo (requerida para ciertos reportes)
 *     responses:
 *       200:
 *         description: Reporte generado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: array
 *                   description: Para `stock-bajo`
 *                   items:
 *                     type: object
 *                     properties:
 *                       nombre:
 *                         type: string
 *                       numero_parte:
 *                         type: string
 *                       marca:
 *                         type: string
 *                       stock_minimo:
 *                         type: integer
 *                       stock_actual:
 *                         type: integer
 *                 - type: array
 *                   description: Para `mas-utilizadas` y `menos-utilizadas`
 *                   items:
 *                     type: object
 *                     properties:
 *                       nombre:
 *                         type: string
 *                       marca:
 *                         type: string
 *                       total_usado:
 *                         type: integer
 *                 - type: array
 *                   description: Para `costo-por-autobus`
 *                   items:
 *                     type: object
 *                     properties:
 *                       economico:
 *                         type: string
 *                       costo_total:
 *                         type: number
 *                         format: float
 *       400:
 *         description: Parámetros inválidos o tipo de reporte no válido
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Tipo de reporte no válido.
 *       500:
 *         description: Error interno del servidor
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Error en el servidor
 */

router.get('/:tipoReporte', async (req, res) => {
  const { tipoReporte } = req.params;
  const { fechaInicio, fechaFin } = req.query;
  let query = '';
  let params = [];

  let dateWhereClause = '';
  if (fechaInicio && fechaFin) {
    dateWhereClause = `AND sa.fecha_salida BETWEEN $1 AND $2`;
    params = [fechaInicio, fechaFin];
  }

  switch (tipoReporte) {
    case 'stock-bajo':
      query = `
        SELECT r.nombre, r.numero_parte, r.marca, r.stock_minimo, 
               COALESCE(SUM(l.cantidad_disponible), 0) as stock_actual
        FROM refaccion r
        LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
        GROUP BY r.id_refaccion
        HAVING COALESCE(SUM(l.cantidad_disponible), 0) <= r.stock_minimo AND r.stock_minimo > 0
        ORDER BY r.nombre ASC`;
      break;

    case 'mas-utilizadas':
      query = `
        SELECT r.nombre, r.marca, SUM(ds.cantidad_despachada) as total_usado
        FROM detalle_salida ds
        JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
        JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
        WHERE 1=1 ${dateWhereClause}
        GROUP BY r.nombre, r.marca
        ORDER BY total_usado DESC
        LIMIT 10;`;
      break;

    case 'menos-utilizadas':
      query = `
        SELECT r.nombre, r.marca, COALESCE(SUM(ds.cantidad_despachada), 0) as total_usado
        FROM refaccion r
        LEFT JOIN detalle_salida ds ON r.id_refaccion = ds.id_refaccion
        LEFT JOIN salida_almacen sa ON ds.id_salida = sa.id_salida AND sa.fecha_salida BETWEEN $1 AND $2
        GROUP BY r.nombre, r.marca
        ORDER BY total_usado ASC
        LIMIT 10;`;
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
      break;
      
    case 'costo-por-autobus':
      query = `
        SELECT a.economico, SUM(ds.cantidad_despachada * l.costo_unitario_compra) as costo_total
        FROM detalle_salida ds
        JOIN lote_refaccion l ON ds.id_lote = l.id_lote
        JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
        JOIN autobus a ON sa.id_autobus = a.id_autobus
        WHERE 1=1 ${dateWhereClause}
        GROUP BY a.economico
        ORDER BY costo_total DESC;`;
      break;

      case 'consumo-insumos-por-autobus':
      query = `
        SELECT 
          a.economico,
          i.nombre as insumo,
          SUM(dsi.cantidad_usada) as total_consumido,
          i.unidad_medida
        FROM detalle_salida_insumo dsi
        JOIN insumo i ON dsi.id_insumo = i.id_insumo
        JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
        JOIN autobus a ON sa.id_autobus = a.id_autobus
        WHERE 1=1 ${dateWhereClause}
        GROUP BY a.economico, i.nombre, i.unidad_medida
        ORDER BY a.economico, total_consumido DESC;`;
      break;

    default:
      return res.status(400).json({ message: 'Tipo de reporte no válido.' });
  }

  try {
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error(`Error al generar reporte [${tipoReporte}]:`, error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

module.exports = router;