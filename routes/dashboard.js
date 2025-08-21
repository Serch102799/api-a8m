const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);

/**
 * @swagger
 * tags:
 *   - name: Dashboard
 *     description: Endpoints para obtener estadísticas generales del almacén
 */

/**
 * @swagger
 * /api/dashboard/stats:
 *   get:
 *     summary: Obtener estadísticas consolidadas para el dashboard
 *     tags: [Dashboard]
 *     responses:
 *       200:
 *         description: Objeto con estadísticas generales del almacén
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalRefacciones:
 *                   type: integer
 *                   example: 150
 *                 refaccionesStockBajo:
 *                   type: integer
 *                   example: 12
 *                 valorTotalInventario:
 *                   type: number
 *                   format: float
 *                   example: 25342.75
 *                 topStock:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       nombre:
 *                         type: string
 *                         example: Filtro de aceite
 *                       stock_actual:
 *                         type: integer
 *                         example: 300
 *                 lowStockItems:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: true
 *                 ultimasEntradas:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: true
 *                 ultimasSalidas:
 *                   type: array
 *                   items:
 *                     type: object
 *                     additionalProperties: true
 *                 topCostoAutobuses:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       economico:
 *                         type: string
 *                         example: "A-203"
 *                       costo_total:
 *                         type: number
 *                         format: float
 *                         example: 12458.99
 */

router.get('/stats', async (req, res) => {
  try {
    const totalRefaccionesPromise = pool.query('SELECT COUNT(*) FROM refaccion');
    
    const stockBajoPromise = pool.query(`
      SELECT COUNT(*) FROM (
        SELECT r.id_refaccion FROM refaccion r
        GROUP BY r.id_refaccion, r.stock_minimo
        HAVING COALESCE((SELECT SUM(cantidad_disponible) FROM lote_refaccion WHERE id_refaccion = r.id_refaccion), 0) <= r.stock_minimo 
               AND r.stock_minimo > 0
      ) as stock_bajo;
    `);

    const valorInventarioPromise = pool.query('SELECT SUM(cantidad_disponible * costo_unitario_final) AS valor_total FROM lote_refaccion');

    const topStockPromise = pool.query(`
  SELECT
    r.nombre,
    COALESCE(SUM(l.cantidad_disponible), 0) AS total_stock
  FROM
    refaccion r
  LEFT JOIN
    lote_refaccion l ON r.id_refaccion = l.id_refaccion
  GROUP BY
    r.id_refaccion, r.nombre  -- Se agrupa por ID y nombre para ser preciso
  ORDER BY
    total_stock DESC
  LIMIT 5
`);

    const lowStockItemsPromise = pool.query(`
      SELECT r.nombre, r.stock_minimo, COALESCE(SUM(l.cantidad_disponible), 0) as stock_actual
      FROM refaccion r
      LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
      GROUP BY r.id_refaccion, r.nombre, r.stock_minimo
      HAVING COALESCE(SUM(l.cantidad_disponible), 0) <= r.stock_minimo AND r.stock_minimo > 0
      ORDER BY (COALESCE(SUM(l.cantidad_disponible), 0)::decimal / NULLIF(r.stock_minimo, 0)) ASC
      LIMIT 5
    `);
    
    const ultimasEntradasPromise = pool.query(`SELECT de.cantidad_recibida, r.nombre as nombre_refaccion, ea.fecha_entrada FROM detalle_entrada de JOIN refaccion r ON de.id_refaccion = r.id_refaccion JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada ORDER BY ea.fecha_entrada DESC LIMIT 5`);
    
    const ultimasSalidasPromise = pool.query(`SELECT ds.cantidad_despachada, r.nombre as nombre_refaccion, sa.fecha_salida FROM detalle_salida ds JOIN refaccion r ON ds.id_refaccion = r.id_refaccion JOIN salida_almacen sa ON ds.id_salida = sa.id_salida ORDER BY sa.fecha_salida DESC LIMIT 5`);

    const topCostoAutobusesPromise = pool.query(`
      SELECT a.economico, SUM(ds.cantidad_despachada * l.costo_unitario_final) as costo_total
      FROM detalle_salida ds
      JOIN lote_refaccion l ON ds.id_lote = l.id_lote
      JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
      JOIN autobus a ON sa.id_autobus = a.id_autobus
      GROUP BY a.economico
      ORDER BY costo_total DESC
      LIMIT 5
    `);

    const [
      totalRefaccionesRes, stockBajoRes, valorInventarioRes, topStockRes,
      lowStockItemsRes, ultimasEntradasRes, ultimasSalidasRes, topCostoAutobusesRes
    ] = await Promise.all([
      totalRefaccionesPromise, stockBajoPromise, valorInventarioPromise, topStockPromise,
      lowStockItemsPromise, ultimasEntradasPromise, ultimasSalidasPromise, topCostoAutobusesPromise
    ]);

    const stats = {
      totalRefacciones: parseInt(totalRefaccionesRes.rows[0].count, 10),
      refaccionesStockBajo: parseInt(stockBajoRes.rows[0].count, 10),
      valorTotalInventario: parseFloat(valorInventarioRes.rows[0].valor_total || 0),
      topStock: topStockRes.rows.map(item => ({
      nombre: item.nombre,
      stock_actual: parseFloat(item.total_stock) // Leer 'total_stock'
  })),
      lowStockItems: lowStockItemsRes.rows,
      ultimasEntradas: ultimasEntradasRes.rows,
      ultimasSalidas: ultimasSalidasRes.rows,
      topCostoAutobuses: topCostoAutobusesRes.rows.map(item => ({
        ...item,
        costo_total: parseFloat(item.costo_total)
      }))
    };

    res.json(stats);

  } catch (error) {
    console.error('Error al obtener estadísticas del dashboard:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

module.exports = router;