
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
    WITH DetallesUnificados AS (
      -- 1. REFACCIONES (Usando tu lógica exacta del historial)
      SELECT 
        sa.id_autobus,
        sa.id_salida,
        sa.fecha_operacion as fecha,
        'Refacción' as tipo_item,
        r.nombre,
        r.marca,
        (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as cantidad,
        COALESCE(l.costo_unitario_final, 0) as costo_unitario,
        ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * COALESCE(l.costo_unitario_final, 0)) as costo_total
      FROM detalle_salida ds
      JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
      JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
      JOIN lote_refaccion l ON ds.id_lote = l.id_lote
      WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2
        AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0

      UNION ALL

      -- 2. INSUMOS (Usando tu lógica exacta del historial)
      SELECT 
        sa.id_autobus,
        sa.id_salida,
        sa.fecha_operacion as fecha,
        'Insumo' as tipo_item,
        i.nombre,
        i.marca,
        (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) as cantidad,
        COALESCE(dsi.costo_al_momento, 0) as costo_unitario,
        ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * COALESCE(dsi.costo_al_momento, 0)) as costo_total
      FROM detalle_salida_insumo dsi
      JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
      JOIN insumo i ON dsi.id_insumo = i.id_insumo
      WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2
        AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0
    ),
    Agrupados AS (
      -- 3. Agrupar por autobús y crear el JSON de detalles
      SELECT 
        id_autobus,
        COUNT(DISTINCT id_salida) as num_servicios,
        SUM(costo_total) as costo_total_bus,
        json_agg(
          json_build_object(
            'fecha', fecha,
            'tipo_item', tipo_item,
            'nombre', nombre,
            'marca', marca,
            'cantidad', cantidad,
            'costo_unitario', costo_unitario,
            'costo_total', costo_total
          ) ORDER BY fecha DESC
        ) as detalles
      FROM DetallesUnificados
      GROUP BY id_autobus
    )
    -- 4. Cruce final con el catálogo de autobuses
    SELECT 
      a.id_autobus,
      a.economico,
      a.marca,
      a.modelo,
      a.razon_social,
      COALESCE(ag.costo_total_bus, 0) as costo_total,
      COALESCE(ag.num_servicios, 0) as num_servicios,
      COALESCE(ag.detalles, '[]'::json) as detalles
    FROM autobus a
    JOIN Agrupados ag ON a.id_autobus = ag.id_autobus
    ORDER BY costo_total DESC NULLS LAST;
  `;
  
  params = [fechaInicio, fechaFinStrAutobus];
  break;
  case 'movimientos-refaccion':
      if (!fechaInicio || !fechaFin) {
        return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
      }

      const fechaFinAjustadaMov = new Date(fechaFin);
      fechaFinAjustadaMov.setDate(fechaFinAjustadaMov.getDate() + 1);
      const fechaFinStrMov = fechaFinAjustadaMov.toISOString().split('T')[0];

      query = `
        WITH Entradas AS (
          SELECT 
            de.id_refaccion,
            SUM(de.cantidad_recibida) as total_entradas,
            json_agg(
              json_build_object(
                'tipo_movimiento', 'Entrada',
                'fecha', ea.fecha_operacion,
                'documento', COALESCE(ea.factura_proveedor, ea.vale_interno, 'N/A'),
                'cantidad', de.cantidad_recibida,
                'costo_unitario', l.costo_unitario_final,
                'costo_total', (de.cantidad_recibida * l.costo_unitario_final)
              ) ORDER BY ea.fecha_operacion DESC
            ) as detalle_entradas
          FROM detalle_entrada de
          JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
          JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
          WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
          GROUP BY de.id_refaccion
        ),
        Salidas AS (
          SELECT 
            ds.id_refaccion,
            SUM(ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as total_salidas,
            json_agg(
              json_build_object(
                'tipo_movimiento', 'Salida',
                'fecha', sa.fecha_operacion,
                'documento', 'Bus ' || a.economico,
                'cantidad', (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)),
                'costo_unitario', l.costo_unitario_final,
                'costo_total', ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final)
              ) ORDER BY sa.fecha_operacion DESC
            ) as detalle_salidas
          FROM detalle_salida ds
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          JOIN lote_refaccion l ON ds.id_lote = l.id_lote
          JOIN autobus a ON sa.id_autobus = a.id_autobus
          WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2
            AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0
          GROUP BY ds.id_refaccion
        )
        SELECT 
          r.id_refaccion,
          r.nombre as articulo,
          r.marca,
          r.numero_parte,
          COALESCE(e.total_entradas, 0) as entradas_periodo,
          COALESCE(s.total_salidas, 0) as salidas_periodo,
          -- UNIÓN PLANA USANDO JSONB (Evita el error de anidamiento)
          (COALESCE(e.detalle_entradas::jsonb, '[]'::jsonb) || COALESCE(s.detalle_salidas::jsonb, '[]'::jsonb)) as detalles
        FROM refaccion r
        LEFT JOIN Entradas e ON r.id_refaccion = e.id_refaccion
        LEFT JOIN Salidas s ON r.id_refaccion = s.id_refaccion
        WHERE e.total_entradas IS NOT NULL OR s.total_salidas IS NOT NULL
        ORDER BY r.nombre ASC;
      `;
      
      params = [fechaInicio, fechaFinStrMov];
      break;

      case 'historial-por-refaccion':
      if (!fechaInicio || !fechaFin) {
        return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
      }

      // 1. Recibimos los IDs y los convertimos en arreglos numéricos
      const { idsRefacciones = '', idsInsumos = '' } = req.query;
      
      const arrRefacciones = idsRefacciones ? idsRefacciones.split(',').map(id => parseInt(id)) : [];
      const arrInsumos = idsInsumos ? idsInsumos.split(',').map(id => parseInt(id)) : [];

      if (arrRefacciones.length === 0 && arrInsumos.length === 0) {
        return res.status(400).json({ message: 'Debes seleccionar al menos una refacción o insumo.' });
      }

      const fechaFinAjustadaEsp = new Date(fechaFin);
      fechaFinAjustadaEsp.setDate(fechaFinAjustadaEsp.getDate() + 1);
      const fechaFinStrEsp = fechaFinAjustadaEsp.toISOString().split('T')[0];

      // Consulta SQL con los parámetros $3 y $4 fijos. 
      // Si los arreglos van vacíos, PostgreSQL evalúa el ANY() como falso automáticamente.
      query = `
        WITH Movimientos AS (
          -- 1. ENTRADAS REFACCIONES
          SELECT 
            de.id_refaccion as id_item, 'Refacción' as tipo_articulo, r.nombre, r.marca,
            'Entrada' as tipo_movimiento, ea.fecha_operacion as fecha, 
            COALESCE(ea.factura_proveedor, ea.vale_interno, 'N/A') as documento,
            de.cantidad_recibida as cantidad, l.costo_unitario_final as costo_unitario,
            (de.cantidad_recibida * l.costo_unitario_final) as costo_total
          FROM detalle_entrada de
          JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
          JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
          JOIN refaccion r ON de.id_refaccion = r.id_refaccion
          WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2 
            AND de.id_refaccion = ANY($3::int[])

          UNION ALL

          -- 2. SALIDAS REFACCIONES
          SELECT 
            ds.id_refaccion as id_item, 'Refacción' as tipo_articulo, r.nombre, r.marca,
            'Salida' as tipo_movimiento, sa.fecha_operacion as fecha, 
            'Bus ' || a.economico as documento,
            (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as cantidad, l.costo_unitario_final as costo_unitario,
            ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total
          FROM detalle_salida ds
          JOIN salida_almacen sa ON ds.id_salida = sa.id_salida
          JOIN lote_refaccion l ON ds.id_lote = l.id_lote
          JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
          JOIN autobus a ON sa.id_autobus = a.id_autobus
          WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 
            AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0 
            AND ds.id_refaccion = ANY($3::int[])

          UNION ALL

          -- 3. ENTRADAS INSUMOS
          SELECT 
            dei.id_insumo as id_item, 'Insumo' as tipo_articulo, i.nombre, i.marca,
            'Entrada' as tipo_movimiento, ea.fecha_operacion as fecha, 
            COALESCE(ea.factura_proveedor, ea.vale_interno, 'N/A') as documento,
            dei.cantidad_recibida as cantidad, dei.costo_unitario_final as costo_unitario,
            (dei.cantidad_recibida * dei.costo_unitario_final) as costo_total
          FROM detalle_entrada_insumo dei
          JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada
          JOIN insumo i ON dei.id_insumo = i.id_insumo
          WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2 
            AND dei.id_insumo = ANY($4::int[])

          UNION ALL

          -- 4. SALIDAS INSUMOS
          SELECT 
            dsi.id_insumo as id_item, 'Insumo' as tipo_articulo, i.nombre, i.marca,
            'Salida' as tipo_movimiento, sa.fecha_operacion as fecha, 
            'Bus ' || a.economico as documento,
            (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) as cantidad, dsi.costo_al_momento as costo_unitario,
            ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total
          FROM detalle_salida_insumo dsi
          JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida
          JOIN insumo i ON dsi.id_insumo = i.id_insumo
          JOIN autobus a ON sa.id_autobus = a.id_autobus
          WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 
            AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0 
            AND dsi.id_insumo = ANY($4::int[])
        )
        SELECT 
          tipo_articulo,
          id_item,
          nombre as articulo,
          marca,
          SUM(CASE WHEN tipo_movimiento = 'Entrada' THEN cantidad ELSE 0 END) as entradas_periodo,
          SUM(CASE WHEN tipo_movimiento = 'Salida' THEN cantidad ELSE 0 END) as salidas_periodo,
          json_agg(
            json_build_object(
              'fecha', fecha,
              'tipo_movimiento', tipo_movimiento,
              'documento', documento,
              'cantidad', cantidad,
              'costo_total', costo_total
            ) ORDER BY fecha DESC
          ) as detalles
        FROM Movimientos
        GROUP BY tipo_articulo, id_item, nombre, marca
        ORDER BY tipo_articulo, nombre ASC;
      `;
      
      // Siempre pasamos exactamente los 4 parámetros esperados en la consulta
      params = [fechaInicio, fechaFinStrEsp, arrRefacciones, arrInsumos];
      break;

    case 'gastos-totales':
      if (!fechaInicio || !fechaFin) {
        return res.status(400).json({ message: 'Se requiere un rango de fechas para este reporte.' });
      }

      const fechaFinAjustada = new Date(fechaFin);
      fechaFinAjustada.setDate(fechaFinAjustada.getDate() + 1);
      const fechaFinStr = fechaFinAjustada.toISOString().split('T')[0];

      try {
        const listaQuery = `
          WITH DetallesUnificados AS (
            -- 1. Refacciones de la entrada
            SELECT
              de.id_entrada,
              ea.fecha_operacion as fecha,
              'Refacción' as tipo_item,
              r.nombre,
              r.marca,
              de.cantidad_recibida as cantidad,
              l.costo_unitario_final as costo_unitario,
              (de.cantidad_recibida * l.costo_unitario_final) as costo_total
            FROM detalle_entrada de
            JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
            JOIN refaccion r ON l.id_refaccion = r.id_refaccion
            JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
            WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2

            UNION ALL

            -- 2. Insumos de la entrada
            SELECT
              dei.id_entrada,
              ea.fecha_operacion as fecha,
              'Insumo' as tipo_item,
              i.nombre,
              i.marca,
              dei.cantidad_recibida as cantidad,
              dei.costo_unitario_final as costo_unitario,
              (dei.cantidad_recibida * dei.costo_unitario_final) as costo_total
            FROM detalle_entrada_insumo dei
            JOIN insumo i ON dei.id_insumo = i.id_insumo
            JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada
            WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
          ),
          Agrupados AS (
            -- 3. Empaquetar todo en formato JSON
            SELECT
              id_entrada,
              SUM(costo_total) as valor_entrada,
              json_agg(
                json_build_object(
                  'fecha', fecha,
                  'tipo_item', tipo_item,
                  'nombre', nombre,
                  'marca', marca,
                  'cantidad', cantidad,
                  'costo_unitario', costo_unitario,
                  'costo_total', costo_total
                ) ORDER BY tipo_item
              ) as detalles
            FROM DetallesUnificados
            GROUP BY id_entrada
          )
          -- 4. Consulta final de la tabla maestra
          SELECT 
            ea.id_entrada,
            ea.fecha_operacion,
            ea.factura_proveedor,
            ea.vale_interno,
            p.nombre_proveedor,
            e.nombre as recibido_por,
            ea.razon_social,
            COALESCE(ag.valor_entrada, 0) AS valor_entrada,
            COALESCE(ag.detalles, '[]'::json) AS detalles
          FROM entrada_almacen ea
          LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
          LEFT JOIN empleado e ON ea.recibido_por_id = e.id_empleado
          LEFT JOIN Agrupados ag ON ea.id_entrada = ag.id_entrada
          WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
          ORDER BY ea.fecha_operacion DESC;
        `;

        const totalQuery = `
          SELECT COALESCE(SUM(valor_entrada), 0) as total_general
          FROM (
            SELECT 
              id_entrada, 
              SUM(total_linea) as valor_entrada 
            FROM (
              SELECT de.id_entrada, (de.cantidad_recibida * l.costo_unitario_final) as total_linea
              FROM detalle_entrada de
              JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
              JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
              WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
              UNION ALL
              SELECT dei.id_entrada, (dei.cantidad_recibida * dei.costo_unitario_final) as total_linea
              FROM detalle_entrada_insumo dei
              JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada
              WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
            ) as details 
            GROUP BY id_entrada
          ) as totales;
        `;

        const listaResult = await pool.query(listaQuery, [fechaInicio, fechaFinStr]);
        const totalResult = await pool.query(totalQuery, [fechaInicio, fechaFinStr]);

        return res.json({
          entradas: listaResult.rows,
          totalGeneral: parseFloat(totalResult.rows[0].total_general || 0)
        });

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