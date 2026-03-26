const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);



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
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Se requiere un rango de fechas.' });
      const fechaFinAjustadaAutobus = new Date(fechaFin);
      fechaFinAjustadaAutobus.setDate(fechaFinAjustadaAutobus.getDate() + 1);
      const fechaFinStrAutobus = fechaFinAjustadaAutobus.toISOString().split('T')[0];
      
      query = `
        WITH Gastos AS (
          SELECT sa.id_autobus, sa.fecha_operacion as fecha, 'Refacción' as tipo_item, r.nombre, r.marca, (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as cantidad, l.costo_unitario_final as costo_unitario, ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total
          FROM detalle_salida ds JOIN salida_almacen sa ON ds.id_salida = sa.id_salida JOIN lote_refaccion l ON ds.id_lote = l.id_lote JOIN refaccion r ON ds.id_refaccion = r.id_refaccion WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0
          UNION ALL
          SELECT sa.id_autobus, sa.fecha_operacion as fecha, 'Insumo' as tipo_item, i.nombre, i.marca, (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) as cantidad, dsi.costo_al_momento as costo_unitario, ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total
          FROM detalle_salida_insumo dsi JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida JOIN insumo i ON dsi.id_insumo = i.id_insumo WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0
          UNION ALL
          SELECT se.id_autobus, se.fecha_servicio as fecha, 'Serv. Externo' as tipo_item, se.descripcion as nombre, COALESCE(p.nombre_proveedor, 'Taller Externo') as marca, 1 as cantidad, se.costo_total as costo_unitario, se.costo_total as costo_total
          FROM servicio_externo se LEFT JOIN proveedor p ON se.id_proveedor = p.id_proveedor WHERE se.fecha_servicio >= $1 AND se.fecha_servicio < $2 AND se.estatus = 'Activo'
          UNION ALL
          SELECT pr.id_autobus_destino as id_autobus, pr.fecha_instalacion as fecha, 'Pieza Recuperada' as tipo_item, r.nombre, r.marca, 1 as cantidad, pr.costo_reparacion as costo_unitario, pr.costo_reparacion as costo_total
          FROM pieza_recuperada pr JOIN refaccion r ON pr.id_refaccion = r.id_refaccion WHERE pr.fecha_instalacion >= $1 AND pr.fecha_instalacion < $2 AND pr.estado = 'Instalada' AND pr.costo_reparacion > 0
        )
        SELECT a.id_autobus, a.economico as autobus, COALESCE(a.razon_social::varchar, 'Sin Razón Social') as razon_social, a.marca as marca_autobus, a.modelo as modelo_autobus, SUM(g.costo_total) as costo_total_mantenimiento,
          json_agg(json_build_object('fecha', g.fecha, 'tipo_item', g.tipo_item, 'nombre', g.nombre, 'marca', g.marca, 'cantidad', g.cantidad, 'costo_unitario', g.costo_unitario, 'costo_total', g.costo_total) ORDER BY g.fecha DESC) as detalles
        FROM Gastos g JOIN autobus a ON g.id_autobus = a.id_autobus 
        GROUP BY a.id_autobus, a.economico, a.razon_social, a.marca, a.modelo 
        ORDER BY costo_total_mantenimiento DESC;
      `;
      params = [fechaInicio, fechaFinStrAutobus];
      break;

    case 'costo-por-autobus-especifico':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Se requiere un rango de fechas.' });
      const { idsAutobuses = '' } = req.query;
      const arrBuses = idsAutobuses ? idsAutobuses.split(',').map(id => parseInt(id)) : [];
      if (arrBuses.length === 0) return res.status(400).json({ message: 'Debes seleccionar al menos un autobús.' });
      const fFinAjustadaBus = new Date(fechaFin); fFinAjustadaBus.setDate(fFinAjustadaBus.getDate() + 1);
      const fFinStrBus = fFinAjustadaBus.toISOString().split('T')[0];
      query = `
        WITH Gastos AS (
          SELECT sa.id_autobus, sa.fecha_operacion as fecha, 'Refacción' as tipo_item, r.nombre, r.marca, (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as cantidad, l.costo_unitario_final as costo_unitario, ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total FROM detalle_salida ds JOIN salida_almacen sa ON ds.id_salida = sa.id_salida JOIN lote_refaccion l ON ds.id_lote = l.id_lote JOIN refaccion r ON ds.id_refaccion = r.id_refaccion WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0 AND sa.id_autobus = ANY($3::int[])
          UNION ALL
          SELECT sa.id_autobus, sa.fecha_operacion as fecha, 'Insumo' as tipo_item, i.nombre, i.marca, (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) as cantidad, dsi.costo_al_momento as costo_unitario, ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total FROM detalle_salida_insumo dsi JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida JOIN insumo i ON dsi.id_insumo = i.id_insumo WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0 AND sa.id_autobus = ANY($3::int[])
          UNION ALL
          SELECT se.id_autobus, se.fecha_servicio as fecha, 'Serv. Externo' as tipo_item, se.descripcion as nombre, COALESCE(p.nombre_proveedor, 'Taller Externo') as marca, 1 as cantidad, se.costo_total as costo_unitario, se.costo_total as costo_total FROM servicio_externo se LEFT JOIN proveedor p ON se.id_proveedor = p.id_proveedor WHERE se.fecha_servicio >= $1 AND se.fecha_servicio < $2 AND se.estatus = 'Activo' AND se.id_autobus = ANY($3::int[])
          UNION ALL
          SELECT pr.id_autobus_destino as id_autobus, pr.fecha_instalacion as fecha, 'Pieza Recuperada' as tipo_item, r.nombre, r.marca, 1 as cantidad, pr.costo_reparacion as costo_unitario, pr.costo_reparacion as costo_total FROM pieza_recuperada pr JOIN refaccion r ON pr.id_refaccion = r.id_refaccion WHERE pr.fecha_instalacion >= $1 AND pr.fecha_instalacion < $2 AND pr.estado = 'Instalada' AND pr.costo_reparacion > 0 AND pr.id_autobus_destino = ANY($3::int[])
        )
        SELECT a.id_autobus, a.economico as autobus, COALESCE(a.razon_social::varchar, 'Sin Razón Social') as razon_social, a.marca as marca_autobus, a.modelo as modelo_autobus, SUM(g.costo_total) as costo_total_mantenimiento, 
          json_agg(json_build_object('fecha', g.fecha, 'tipo_item', g.tipo_item, 'nombre', g.nombre, 'marca', g.marca, 'cantidad', g.cantidad, 'costo_unitario', g.costo_unitario, 'costo_total', g.costo_total) ORDER BY g.fecha DESC) as detalles
        FROM Gastos g JOIN autobus a ON g.id_autobus = a.id_autobus 
        GROUP BY a.id_autobus, a.economico, a.razon_social, a.marca, a.modelo 
        ORDER BY costo_total_mantenimiento DESC;
      `;
      params = [fechaInicio, fFinStrBus, arrBuses];
      break;

    case 'compras-razon-social':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Rango de fechas requerido.' });
      const fFinCR = new Date(fechaFin); fFinCR.setDate(fFinCR.getDate() + 1);
      const fFinStrCR = fFinCR.toISOString().split('T')[0];
      query = `
        WITH Entradas AS (
          SELECT COALESCE(ea.razon_social::varchar, 'Sin Razón Social') as razon_social, ea.fecha_operacion as fecha, COALESCE(ea.factura_proveedor, ea.vale_interno, 'S/D') as documento, COALESCE(p.nombre_proveedor, 'N/A') as proveedor, COALESCE(sub.total_entrada, 0) as costo_total
          FROM entrada_almacen ea
          LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
          LEFT JOIN (
            SELECT id_entrada, SUM(cantidad_recibida * costo_unitario_final) as total_entrada
            FROM (
              SELECT de.id_entrada, de.cantidad_recibida, l.costo_unitario_final FROM detalle_entrada de JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
              UNION ALL SELECT dei.id_entrada, dei.cantidad_recibida, dei.costo_unitario_final FROM detalle_entrada_insumo dei
            ) t GROUP BY id_entrada
          ) sub ON ea.id_entrada = sub.id_entrada
          WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
          
          UNION ALL
          
          SELECT 'Sin Razón Social'::varchar as razon_social, pr.fecha_retorno as fecha, pr.factura_reparacion as documento, COALESCE(p.nombre_proveedor, 'N/A') as proveedor, pr.costo_reparacion as costo_total
          FROM pieza_recuperada pr LEFT JOIN proveedor p ON pr.id_proveedor_reparacion = p.id_proveedor
          WHERE pr.fecha_retorno >= $1 AND pr.fecha_retorno < $2 AND pr.estado IN ('Disponible', 'Instalada') AND pr.costo_reparacion > 0
        )
        SELECT razon_social, SUM(costo_total) as costo_total_general,
          json_agg(json_build_object('fecha', fecha, 'documento', documento, 'proveedor', proveedor, 'costo_total', costo_total) ORDER BY fecha DESC) as detalles
        FROM Entradas GROUP BY razon_social ORDER BY costo_total_general DESC;
      `;
      params = [fechaInicio, fFinStrCR];
      break;

    case 'gastos-razon-social':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Rango de fechas requerido.' });
      const fFinGR = new Date(fechaFin); fFinGR.setDate(fFinGR.getDate() + 1);
      const fFinStrGR = fFinGR.toISOString().split('T')[0];
      query = `
        WITH Gastos AS (
          SELECT sa.id_autobus, sa.fecha_operacion as fecha, 'Refacción' as tipo, r.nombre as descripcion, ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total
          FROM detalle_salida ds JOIN salida_almacen sa ON ds.id_salida = sa.id_salida JOIN lote_refaccion l ON ds.id_lote = l.id_lote JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
          WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0
          UNION ALL
          SELECT sa.id_autobus, sa.fecha_operacion as fecha, 'Insumo' as tipo, i.nombre as descripcion, ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total
          FROM detalle_salida_insumo dsi JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida JOIN insumo i ON dsi.id_insumo = i.id_insumo
          WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0
          UNION ALL
          SELECT se.id_autobus, se.fecha_servicio as fecha, 'Serv. Externo' as tipo, se.descripcion, se.costo_total
          FROM servicio_externo se WHERE se.fecha_servicio >= $1 AND se.fecha_servicio < $2 AND se.estatus = 'Activo'
          UNION ALL
          SELECT pr.id_autobus_destino as id_autobus, pr.fecha_instalacion as fecha, 'Pieza Recuperada' as tipo, r.nombre as descripcion, pr.costo_reparacion as costo_total
          FROM pieza_recuperada pr JOIN refaccion r ON pr.id_refaccion = r.id_refaccion WHERE pr.fecha_instalacion >= $1 AND pr.fecha_instalacion < $2 AND pr.estado = 'Instalada' AND pr.costo_reparacion > 0
        )
        SELECT COALESCE(a.razon_social::varchar, 'Sin Razón Social') as razon_social, SUM(g.costo_total) as costo_total_general,
          json_agg(json_build_object('fecha', g.fecha, 'autobus', a.economico, 'tipo', g.tipo, 'descripcion', g.descripcion, 'costo_total', g.costo_total) ORDER BY g.fecha DESC) as detalles
        FROM Gastos g JOIN autobus a ON g.id_autobus = a.id_autobus GROUP BY a.razon_social ORDER BY costo_total_general DESC;
      `;
      params = [fechaInicio, fFinStrGR];
      break;

    case 'movimientos-refaccion':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Rango de fechas requerido.' });
      const fFinMov = new Date(fechaFin); fFinMov.setDate(fFinMov.getDate() + 1);
      const fFinStrMov = fFinMov.toISOString().split('T')[0];
      query = `
        WITH Entradas AS (
          SELECT de.id_refaccion, SUM(de.cantidad_recibida) as total_entradas, json_agg(json_build_object('tipo_movimiento', 'Entrada', 'fecha', ea.fecha_operacion, 'documento', COALESCE(ea.factura_proveedor, ea.vale_interno, 'N/A'), 'cantidad', de.cantidad_recibida, 'costo_unitario', l.costo_unitario_final, 'costo_total', (de.cantidad_recibida * l.costo_unitario_final)) ORDER BY ea.fecha_operacion DESC) as detalle_entradas
          FROM detalle_entrada de JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2 GROUP BY de.id_refaccion
        ),
        Salidas AS (
          SELECT ds.id_refaccion, SUM(ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as total_salidas, json_agg(json_build_object('tipo_movimiento', 'Salida', 'fecha', sa.fecha_operacion, 'documento', 'Bus ' || a.economico, 'cantidad', (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)), 'costo_unitario', l.costo_unitario_final, 'costo_total', ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final)) ORDER BY sa.fecha_operacion DESC) as detalle_salidas
          FROM detalle_salida ds JOIN salida_almacen sa ON ds.id_salida = sa.id_salida JOIN lote_refaccion l ON ds.id_lote = l.id_lote JOIN autobus a ON sa.id_autobus = a.id_autobus WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0 GROUP BY ds.id_refaccion
        )
        SELECT r.id_refaccion, r.nombre as articulo, r.marca, r.numero_parte, COALESCE(e.total_entradas, 0) as entradas_periodo, COALESCE(s.total_salidas, 0) as salidas_periodo, (COALESCE(e.detalle_entradas::jsonb, '[]'::jsonb) || COALESCE(s.detalle_salidas::jsonb, '[]'::jsonb)) as detalles
        FROM refaccion r LEFT JOIN Entradas e ON r.id_refaccion = e.id_refaccion LEFT JOIN Salidas s ON r.id_refaccion = s.id_refaccion WHERE e.total_entradas IS NOT NULL OR s.total_salidas IS NOT NULL ORDER BY r.nombre ASC;
      `;
      params = [fechaInicio, fFinStrMov];
      break;

    case 'historial-por-refaccion':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Rango de fechas requerido.' });
      const { idsRefacciones = '', idsInsumos = '' } = req.query;
      const arrRefacciones = idsRefacciones ? idsRefacciones.split(',').map(id => parseInt(id)) : [];
      const arrInsumos = idsInsumos ? idsInsumos.split(',').map(id => parseInt(id)) : [];
      if (arrRefacciones.length === 0 && arrInsumos.length === 0) return res.status(400).json({ message: 'Selecciona al menos una refacción o insumo.' });
      const fFinEsp = new Date(fechaFin); fFinEsp.setDate(fFinEsp.getDate() + 1);
      const fFinStrEsp = fFinEsp.toISOString().split('T')[0];
      query = `
        WITH Movimientos AS (
          SELECT de.id_refaccion as id_item, 'Refacción' as tipo_articulo, r.nombre, r.marca, 'Entrada' as tipo_movimiento, ea.fecha_operacion as fecha, COALESCE(ea.factura_proveedor, ea.vale_interno, 'N/A') as documento, de.cantidad_recibida as cantidad, l.costo_unitario_final as costo_unitario, (de.cantidad_recibida * l.costo_unitario_final) as costo_total FROM detalle_entrada de JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada JOIN refaccion r ON de.id_refaccion = r.id_refaccion WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2 AND de.id_refaccion = ANY($3::int[])
          UNION ALL SELECT ds.id_refaccion as id_item, 'Refacción' as tipo_articulo, r.nombre, r.marca, 'Salida' as tipo_movimiento, sa.fecha_operacion as fecha, 'Bus ' || a.economico as documento, (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) as cantidad, l.costo_unitario_final as costo_unitario, ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total FROM detalle_salida ds JOIN salida_almacen sa ON ds.id_salida = sa.id_salida JOIN lote_refaccion l ON ds.id_lote = l.id_lote JOIN refaccion r ON ds.id_refaccion = r.id_refaccion JOIN autobus a ON sa.id_autobus = a.id_autobus WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0 AND ds.id_refaccion = ANY($3::int[])
          UNION ALL SELECT dei.id_insumo as id_item, 'Insumo' as tipo_articulo, i.nombre, i.marca, 'Entrada' as tipo_movimiento, ea.fecha_operacion as fecha, COALESCE(ea.factura_proveedor, ea.vale_interno, 'N/A') as documento, dei.cantidad_recibida as cantidad, dei.costo_unitario_final as costo_unitario, (dei.cantidad_recibida * dei.costo_unitario_final) as costo_total FROM detalle_entrada_insumo dei JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada JOIN insumo i ON dei.id_insumo = i.id_insumo WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2 AND dei.id_insumo = ANY($4::int[])
          UNION ALL SELECT dsi.id_insumo as id_item, 'Insumo' as tipo_articulo, i.nombre, i.marca, 'Salida' as tipo_movimiento, sa.fecha_operacion as fecha, 'Bus ' || a.economico as documento, (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) as cantidad, dsi.costo_al_momento as costo_unitario, ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total FROM detalle_salida_insumo dsi JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida JOIN insumo i ON dsi.id_insumo = i.id_insumo JOIN autobus a ON sa.id_autobus = a.id_autobus WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0 AND dsi.id_insumo = ANY($4::int[])
        )
        SELECT tipo_articulo, id_item, nombre as articulo, marca, SUM(CASE WHEN tipo_movimiento = 'Entrada' THEN cantidad ELSE 0 END) as entradas_periodo, SUM(CASE WHEN tipo_movimiento = 'Salida' THEN cantidad ELSE 0 END) as salidas_periodo, json_agg(json_build_object('fecha', fecha, 'tipo_movimiento', tipo_movimiento, 'documento', documento, 'cantidad', cantidad, 'costo_total', costo_total) ORDER BY fecha DESC) as detalles
        FROM Movimientos GROUP BY tipo_articulo, id_item, nombre, marca ORDER BY tipo_articulo, nombre ASC;
      `;
      params = [fechaInicio, fFinStrEsp, arrRefacciones, arrInsumos];
      break;

    case 'gastos-totales':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Rango de fechas requerido.' });
      const fFinGT = new Date(fechaFin); fFinGT.setDate(fFinGT.getDate() + 1);
      const fFinStrGT = fFinGT.toISOString().split('T')[0];

      try {
        const listaQuery = `
          WITH DetallesUnificados AS (
            SELECT 
              de.id_entrada, 
              ea.fecha_operacion as fecha, 
              'Refacción'::varchar as tipo_item, 
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
            
            SELECT 
              dei.id_entrada, 
              ea.fecha_operacion as fecha, 
              'Insumo'::varchar as tipo_item, 
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
            SELECT id_entrada, SUM(costo_total) as valor_entrada, 
              json_agg(json_build_object('fecha', fecha, 'tipo_item', tipo_item, 'nombre', nombre, 'marca', marca, 'cantidad', cantidad, 'costo_unitario', costo_unitario, 'costo_total', costo_total) ORDER BY tipo_item) as detalles
            FROM DetallesUnificados GROUP BY id_entrada
          ),
          EntradasMaestro AS (
            SELECT 
              ea.id_entrada, 
              ea.fecha_operacion, 
              ea.factura_proveedor, 
              ea.vale_interno, 
              p.nombre_proveedor, 
              e.nombre as recibido_por, 
              ea.razon_social::varchar, 
              COALESCE(ag.valor_entrada, 0) AS valor_entrada, 
              COALESCE(ag.detalles, '[]'::json) AS detalles 
            FROM entrada_almacen ea 
            LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor 
            LEFT JOIN empleado e ON ea.recibido_por_id = e.id_empleado 
            LEFT JOIN Agrupados ag ON ea.id_entrada = ag.id_entrada 
            WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
            
            UNION ALL 
            
            SELECT 
              (pr.id_pieza_recuperada + 9000000) as id_entrada, 
              pr.fecha_retorno as fecha_operacion, 
              pr.factura_reparacion as factura_proveedor, 
              'Reparación Externa'::varchar as vale_interno, 
              p.nombre_proveedor, 
              'Taller / Mecánico'::varchar as recibido_por, 
              'N/A'::varchar as razon_social, 
              pr.costo_reparacion as valor_entrada, 
              json_build_array(json_build_object('fecha', pr.fecha_retorno, 'tipo_item', 'Reparación de Casco', 'nombre', r.nombre, 'marca', r.marca, 'cantidad', 1, 'costo_unitario', pr.costo_reparacion, 'costo_total', pr.costo_reparacion))::json as detalles 
            FROM pieza_recuperada pr 
            JOIN refaccion r ON pr.id_refaccion = r.id_refaccion 
            LEFT JOIN proveedor p ON pr.id_proveedor_reparacion = p.id_proveedor 
            WHERE pr.fecha_retorno >= $1 AND pr.fecha_retorno < $2 
              AND pr.estado IN ('Disponible', 'Instalada') AND pr.costo_reparacion > 0
          )
          SELECT * FROM EntradasMaestro ORDER BY fecha_operacion DESC;
        `;

        const totalQuery = `
          SELECT COALESCE(SUM(valor_entrada), 0) as total_general
          FROM (
            SELECT id_entrada, SUM(total_linea) as valor_entrada 
            FROM (
              SELECT de.id_entrada, (de.cantidad_recibida * l.costo_unitario_final) as total_linea FROM detalle_entrada de JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
              UNION ALL SELECT dei.id_entrada, (dei.cantidad_recibida * dei.costo_unitario_final) as total_linea FROM detalle_entrada_insumo dei JOIN entrada_almacen ea ON dei.id_entrada = ea.id_entrada WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
              UNION ALL SELECT (pr.id_pieza_recuperada + 9000000) as id_entrada, pr.costo_reparacion as total_linea FROM pieza_recuperada pr WHERE pr.fecha_retorno >= $1 AND pr.fecha_retorno < $2 AND pr.estado IN ('Disponible', 'Instalada') AND pr.costo_reparacion > 0
            ) as details GROUP BY id_entrada
          ) as totales;
        `;

        const listaResult = await pool.query(listaQuery, [fechaInicio, fFinStrGT]);
        const totalResult = await pool.query(totalQuery, [fechaInicio, fFinStrGT]);

        return res.json({ 
          entradas: listaResult.rows, 
          totalGeneral: parseFloat(totalResult.rows[0].total_general || 0) 
        });
        
      } catch (error) {
        console.error('Error al generar gastos totales:', error);
        return res.status(500).json({ message: 'Error al generar el reporte de gastos totales', error: error.message });
      }

    case 'dashboard-kpis':
      if (!fechaInicio || !fechaFin) return res.status(400).json({ message: 'Rango de fechas requerido.' });
      const fFinDash = new Date(fechaFin); fFinDash.setDate(fFinDash.getDate() + 1);
      const fFinStrDash = fFinDash.toISOString().split('T')[0];

      try {
        const queryComprasPie = `
          WITH Entradas AS (
            SELECT COALESCE(ea.razon_social::varchar, 'Sin Razón Social') as razon_social, COALESCE(sub.total_entrada, 0) as costo_total
            FROM entrada_almacen ea
            LEFT JOIN (
              SELECT id_entrada, SUM(cantidad_recibida * costo_unitario_final) as total_entrada
              FROM (
                SELECT de.id_entrada, de.cantidad_recibida, l.costo_unitario_final FROM detalle_entrada de JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
                UNION ALL SELECT dei.id_entrada, dei.cantidad_recibida, dei.costo_unitario_final FROM detalle_entrada_insumo dei
              ) t GROUP BY id_entrada
            ) sub ON ea.id_entrada = sub.id_entrada
            WHERE ea.fecha_operacion >= $1 AND ea.fecha_operacion < $2
            UNION ALL
            SELECT 'Sin Razón Social'::varchar as razon_social, pr.costo_reparacion as costo_total
            FROM pieza_recuperada pr
            WHERE pr.fecha_retorno >= $1 AND pr.fecha_retorno < $2 AND pr.estado IN ('Disponible', 'Instalada') AND pr.costo_reparacion > 0
          )
          SELECT razon_social, SUM(costo_total) as total
          FROM Entradas GROUP BY razon_social HAVING SUM(costo_total) > 0 ORDER BY total DESC;
        `;

        const queryGastosPie = `
          WITH Gastos AS (
            SELECT sa.id_autobus, ((ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) * l.costo_unitario_final) as costo_total
            FROM detalle_salida ds JOIN salida_almacen sa ON ds.id_salida = sa.id_salida JOIN lote_refaccion l ON ds.id_lote = l.id_lote WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0
            UNION ALL
            SELECT sa.id_autobus, ((dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) * dsi.costo_al_momento) as costo_total
            FROM detalle_salida_insumo dsi JOIN salida_almacen sa ON dsi.id_salida = sa.id_salida WHERE sa.fecha_operacion >= $1 AND sa.fecha_operacion < $2 AND (dsi.cantidad_usada - COALESCE(dsi.cantidad_devuelta, 0)) > 0
            UNION ALL
            SELECT se.id_autobus, se.costo_total
            FROM servicio_externo se WHERE se.fecha_servicio >= $1 AND se.fecha_servicio < $2 AND se.estatus = 'Activo'
            UNION ALL
            SELECT pr.id_autobus_destino as id_autobus, pr.costo_reparacion as costo_total
            FROM pieza_recuperada pr WHERE pr.fecha_instalacion >= $1 AND pr.fecha_instalacion < $2 AND pr.estado = 'Instalada' AND pr.costo_reparacion > 0
          )
          SELECT COALESCE(a.razon_social::varchar, 'Sin Razón Social') as razon_social, SUM(g.costo_total) as total
          FROM Gastos g JOIN autobus a ON g.id_autobus = a.id_autobus GROUP BY a.razon_social HAVING SUM(g.costo_total) > 0 ORDER BY total DESC;
        `;

        const [comprasRes, gastosRes] = await Promise.all([
          pool.query(queryComprasPie, [fechaInicio, fFinStrDash]),
          pool.query(queryGastosPie, [fechaInicio, fFinStrDash])
        ]);

        return res.json({
          compras: comprasRes.rows,
          gastos: gastosRes.rows
        });

      } catch (err) {
        return res.status(500).json({ message: 'Error al obtener KPIs del dashboard', error: err.message });
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