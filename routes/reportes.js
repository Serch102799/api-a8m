
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
    dateWhereClause = `AND sa.fecha_operacion BETWEEN $1 AND $2`;
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
        LEFT JOIN salida_almacen sa ON ds.id_salida = sa.id_salida AND sa.fecha_operacion BETWEEN $1 AND $2
        GROUP BY r.nombre, r.marca
        ORDER BY total_usado ASC
        LIMIT 10;`;
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
      break;

    case 'costo-autobus':
  if (!fechaInicio || !fechaFin) {
    return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
  }
  
  const fechaFinAjustadaAutobus = new Date(fechaFin);
  fechaFinAjustadaAutobus.setDate(fechaFinAjustadaAutobus.getDate() + 1);
  const fechaFinStrAutobus = fechaFinAjustadaAutobus.toISOString().split('T')[0];
  
  query = `
    SELECT 
      a.id_autobus,
      a.economico,
      a.marca,
      a.modelo,
      a.razon_social,
      COALESCE(costos.costo_total, 0) as costo_total,
      COALESCE(costos.num_servicios, 0) as num_servicios
    FROM autobus a
    LEFT JOIN (
      SELECT 
        sa.id_autobus,
        COUNT(DISTINCT sa.id_salida) as num_servicios,
        SUM(COALESCE(refacciones_costo, 0) + COALESCE(insumos_costo, 0)) as costo_total
      FROM salida_almacen sa
      LEFT JOIN (
        SELECT 
          ds.id_salida,
          SUM((ds.cantidad_despachada - ds.cantidad_devuelta) * l.costo_unitario_final) as refacciones_costo
        FROM detalle_salida ds
        JOIN lote_refaccion l ON ds.id_lote = l.id_lote
        GROUP BY ds.id_salida
      ) refacciones ON sa.id_salida = refacciones.id_salida
      LEFT JOIN (
        SELECT 
          dsi.id_salida,
          SUM((dsi.cantidad_usada - dsi.cantidad_devuelta) * dsi.costo_al_momento) as insumos_costo
        FROM detalle_salida_insumo dsi
        GROUP BY dsi.id_salida
      ) insumos ON sa.id_salida = insumos.id_salida
      WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2
      GROUP BY sa.id_autobus
    ) costos ON a.id_autobus = costos.id_autobus
    ORDER BY costos.costo_total DESC NULLS LAST;
  `;
  
  params = [fechaInicio, fechaFinStrAutobus];
  break;

    case 'gastos-totales':
      if (!fechaInicio || !fechaFin) {
        return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
      }

      const fechaFinAjustada = new Date(fechaFin);
      fechaFinAjustada.setDate(fechaFinAjustada.getDate() + 1);
      const fechaFinStr = fechaFinAjustada.toISOString().split('T')[0];

      console.log('Fecha Inicio:', fechaInicio);
      console.log('Fecha Fin Ajustada:', fechaFinStr);

      // Primero probemos una query simple para ver si hay entradas
      const testQuery = `
    SELECT 
      ea.id_entrada,
      ea.fecha_operacion,
      ea.factura_proveedor,
      p.nombre_proveedor
    FROM entrada_almacen ea
    LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
    WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
    ORDER BY ea.fecha_operacion DESC;
  `;

      try {
        const testResult = await pool.query(testQuery, [fechaInicio, fechaFinStr]);
        console.log('Entradas encontradas:', testResult.rows.length);
        console.log('Primera entrada:', testResult.rows[0]);

        // Si hay entradas, probamos la query completa
        if (testResult.rows.length > 0) {
          const listaQuery = `
        SELECT 
          ea.id_entrada,
          ea.fecha_operacion,
          ea.factura_proveedor,
          ea.vale_interno,
          p.nombre_proveedor,
          e.nombre as recibido_por,
          ea.razon_social,
          COALESCE(entry_totals.valor_neto, 0) AS valor_entrada
        FROM entrada_almacen ea
        LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
        LEFT JOIN empleado e ON ea.recibido_por_id = e.id_empleado
        LEFT JOIN (
          SELECT 
            id_entrada, 
            SUM(total_linea) as valor_neto 
          FROM (
            SELECT
              de.id_entrada,
              (de.cantidad_recibida * l.costo_unitario_final) as total_linea
            FROM detalle_entrada de
            JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
            UNION ALL
            SELECT
              dei.id_entrada,
              (dei.cantidad_recibida * dei.costo_unitario_final) as total_linea
            FROM detalle_entrada_insumo dei
          ) as details 
          GROUP BY id_entrada
        ) as entry_totals ON ea.id_entrada = entry_totals.id_entrada
        WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
        ORDER BY ea.fecha_operacion DESC;
      `;

          const totalQuery = `
        SELECT COALESCE(SUM(valor_neto), 0) as total_general
        FROM (
          SELECT 
            id_entrada, 
            SUM(total_linea) as valor_neto 
          FROM (
            SELECT
              de.id_entrada,
              (de.cantidad_recibida * l.costo_unitario_final) as total_linea
            FROM detalle_entrada de
            JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
            JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
            WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
            UNION ALL
            SELECT
              dei.id_entrada,
              (dei.cantidad_recibida * dei.costo_unitario_final) as total_linea
            FROM detalle_entrada_insumo dei
            JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada
            WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
          ) as details 
          GROUP BY id_entrada
        ) as totales;
      `;

          const listaResult = await pool.query(listaQuery, [fechaInicio, fechaFinStr]);
          const totalResult = await pool.query(totalQuery, [fechaInicio, fechaFinStr]);

          console.log('Resultados finales:', listaResult.rows.length);
          console.log('Datos completos:', JSON.stringify(listaResult.rows, null, 2));
          console.log('Total general:', totalResult.rows[0].total_general);

          return res.json({
            entradas: listaResult.rows,
            totalGeneral: parseFloat(totalResult.rows[0].total_general || 0)
          });
        } else {
          return res.json({
            entradas: [],
            totalGeneral: 0,
            mensaje: 'No se encontraron entradas en el rango de fechas especificado'
          });
        }

      } catch (error) {
        console.error('Error al obtener gastos totales:', error);
        return res.status(500).json({ message: 'Error al generar el reporte de gastos totales', error: error.message });
      }

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