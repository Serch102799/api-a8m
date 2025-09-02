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

router.get('/stats', verifyToken, async (req, res) => {
  try {
    // --- Promesas para KPIs (Indicadores Clave) ---
    const totalRefaccionesPromise = pool.query('SELECT COUNT(*) FROM refaccion');
    const totalInsumosPromise = pool.query('SELECT COUNT(*) FROM insumo');
    const totalPiezasRefaccionesPromise = pool.query("SELECT COALESCE(SUM(cantidad_disponible), 0) AS total_piezas FROM lote_refaccion");
    const stockBajoRefaccionesPromise = pool.query(`
      SELECT COUNT(*) FROM (
        SELECT r.id_refaccion FROM refaccion r
        LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
        GROUP BY r.id_refaccion, r.stock_minimo
        HAVING COALESCE(SUM(l.cantidad_disponible), 0) <= r.stock_minimo AND r.stock_minimo > 0
      ) as stock_bajo
    `);
    const stockBajoInsumosPromise = pool.query('SELECT COUNT(*) FROM insumo WHERE stock_actual <= stock_minimo AND stock_minimo > 0');
    const valorInventarioRefaccionesPromise = pool.query('SELECT SUM(cantidad_disponible * costo_unitario_final) AS valor_total FROM lote_refaccion');
    const valorInventarioInsumosPromise = pool.query('SELECT SUM(stock_actual * costo_unitario_promedio) AS valor_total FROM insumo');

    // --- Promesas para Gráficas y Listas ---
    const topStockRefaccionesPromise = pool.query(`
      SELECT r.nombre, COALESCE(SUM(l.cantidad_disponible), 0) AS total_stock
      FROM refaccion r
      LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
      GROUP BY r.id_refaccion, r.nombre
      ORDER BY total_stock DESC LIMIT 5
    `);
    const topStockInsumosPromise = pool.query('SELECT nombre, stock_actual FROM insumo ORDER BY stock_actual DESC LIMIT 5');
    const lowStockRefaccionesPromise = pool.query(`
      SELECT r.nombre, r.stock_minimo, COALESCE(SUM(l.cantidad_disponible), 0) as stock_actual
      FROM refaccion r
      LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
      GROUP BY r.id_refaccion, r.nombre, r.stock_minimo
      HAVING COALESCE(SUM(l.cantidad_disponible), 0) <= r.stock_minimo AND r.stock_minimo > 0
      ORDER BY (COALESCE(SUM(l.cantidad_disponible), 0)::decimal / NULLIF(r.stock_minimo, 0)) ASC
      LIMIT 5
    `);
    const lowStockInsumosPromise = pool.query(`
      SELECT nombre, stock_minimo, stock_actual
      FROM insumo
      WHERE stock_actual <= stock_minimo AND stock_minimo > 0
      ORDER BY (stock_actual::decimal / NULLIF(stock_minimo, 0)) ASC
      LIMIT 5
    `);
    const ultimasEntradasPromise = pool.query(`
      (SELECT ea.fecha_operacion, r.nombre AS nombre_item, de.cantidad_recibida, 'Refacción' as tipo_item
       FROM detalle_entrada de
       JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
       JOIN refaccion r ON de.id_refaccion = r.id_refaccion)
      UNION ALL
      (SELECT ea.fecha_operacion, i.nombre AS nombre_item, dei.cantidad_recibida, 'Insumo' as tipo_item
       FROM detalle_entrada_insumo dei
       JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada
       JOIN insumo i ON dei.id_insumo = i.id_insumo)
      ORDER BY fecha_operacion DESC
      LIMIT 5
    `);
    const ultimasSalidasPromise = pool.query(`
      (SELECT s.fecha_operacion, r.nombre AS nombre_item, ds.cantidad_despachada AS cantidad, 'Refacción' as tipo_item
       FROM detalle_salida ds
       JOIN salida_almacen s ON ds.id_salida = s.id_salida
       JOIN lote_refaccion l ON ds.id_lote = l.id_lote
       JOIN refaccion r ON l.id_refaccion = r.id_refaccion)
      UNION ALL
      (SELECT s.fecha_operacion, i.nombre AS nombre_item, dsi.cantidad_usada AS cantidad, 'Insumo' as tipo_item
       FROM detalle_salida_insumo dsi
       JOIN salida_almacen s ON dsi.id_salida = s.id_salida
       JOIN insumo i ON dsi.id_insumo = i.id_insumo)
      ORDER BY fecha_operacion DESC
      LIMIT 5
    `);
    const topCostoAutobusesPromise = pool.query(`
      SELECT a.economico, COALESCE(SUM(costos.costo_total), 0) as costo_total
      FROM autobus a
      LEFT JOIN (
          SELECT sa.id_autobus, SUM(ds.cantidad_despachada * l.costo_unitario_final) as costo_total
          FROM detalle_salida ds
          JOIN lote_refaccion l ON ds.id_lote = l.id_lote
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          GROUP BY sa.id_autobus
          UNION ALL
          SELECT sa.id_autobus, SUM(dsi.cantidad_usada * i.costo_unitario_promedio) as costo_total
          FROM detalle_salida_insumo dsi
          JOIN insumo i ON dsi.id_insumo = i.id_insumo
          JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
          GROUP BY sa.id_autobus
      ) as costos ON a.id_autobus = costos.id_autobus
      GROUP BY a.id_autobus, a.economico
      ORDER BY costo_total DESC
      LIMIT 5
    `);

    // Ejecutar todas las promesas en paralelo
    const [
      totalRefaccionesRes, totalInsumosRes,totalPiezasRefaccionesRes, stockBajoRefaccionesRes, stockBajoInsumosRes,
      valorInventarioRefaccionesRes, valorInventarioInsumosRes, topStockRefaccionesRes,
      topStockInsumosRes, lowStockRefaccionesRes, lowStockInsumosRes,
      ultimasEntradasRes, ultimasSalidasRes, topCostoAutobusesRes
    ] = await Promise.all([
      totalRefaccionesPromise, totalInsumosPromise,totalPiezasRefaccionesPromise, stockBajoRefaccionesPromise, stockBajoInsumosPromise,
      valorInventarioRefaccionesPromise, valorInventarioInsumosPromise, topStockRefaccionesPromise,
      topStockInsumosPromise, lowStockRefaccionesPromise, lowStockInsumosPromise,
      ultimasEntradasPromise, ultimasSalidasPromise, topCostoAutobusesPromise
    ]);

    // Procesar y combinar los resultados
    const valorTotalInventario = (parseFloat(valorInventarioRefaccionesRes.rows[0]?.valor_total) || 0) + 
                                 (parseFloat(valorInventarioInsumosRes.rows[0]?.valor_total) || 0);

    const stats = {
      totalRefacciones: parseInt(totalRefaccionesRes.rows[0].count, 10),
      totalInsumos: parseInt(totalInsumosRes.rows[0].count, 10),
      totalPiezasRefacciones: parseInt(totalPiezasRefaccionesRes.rows[0].total_piezas, 10) || 0,
      refaccionesStockBajo: parseInt(stockBajoRefaccionesRes.rows[0].count, 10),
      insumosStockBajo: parseInt(stockBajoInsumosRes.rows[0].count, 10),
      valorTotalInventario: valorTotalInventario,
      topStockRefacciones: topStockRefaccionesRes.rows.map(item => ({ nombre: item.nombre, stock_actual: parseFloat(item.total_stock) })),
      topStockInsumos: topStockInsumosRes.rows,
      lowStockRefacciones: lowStockRefaccionesRes.rows,
      lowStockInsumos: lowStockInsumosRes.rows,
      ultimasEntradas: ultimasEntradasRes.rows,
      ultimasSalidas: ultimasSalidasRes.rows,
      topCostoAutobuses: topCostoAutobusesRes.rows.map(item => ({ ...item, costo_total: parseFloat(item.costo_total) }))
    };

    res.json(stats);

  } catch (error) {
    console.error('Error al obtener estadísticas del dashboard:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});
module.exports = router;