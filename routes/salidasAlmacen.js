// routes/salidaAlmacen.js
const express = require('express');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
// const checkRole = require('../middleware/checkRole'); // Descomentar si lo usas
const router = express.Router();

const { registrarAuditoria } = require('../servicios/auditService');

// =======================================================
// CREAR NUEVO VALE DE SALIDA MAESTRO
// =======================================================
router.post('/', verifyToken, async (req, res) => {
  const {
    Tipo_Salida,
    ID_Autobus,
    ID_Vehiculo_Particular,
    Solicitado_Por_ID,
    Observaciones,
    Kilometraje_Autobus,
    Fecha_Operacion
  } = req.body;

  try {
    const query = `
      INSERT INTO salida_almacen 
      (tipo_salida, id_autobus, id_vehiculo_particular, solicitado_por_id, observaciones, kilometraje_autobus, fecha_operacion)
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING id_salida
    `;

    const values = [
      Tipo_Salida,
      ID_Autobus || null,
      ID_Vehiculo_Particular || null,
      Solicitado_Por_ID,
      Observaciones || '',
      Kilometraje_Autobus || null,
      Fecha_Operacion
    ];

    const result = await pool.query(query, values);
    const idSalidaGenerado = result.rows[0].id_salida;

    // 🛡️ REGISTRO DE AUDITORÍA: CREACIÓN DE VALE MAESTRO DE SALIDA
    registrarAuditoria({
      id_usuario: req.user.id, // Viene del verifyToken
      tipo_accion: 'CREAR',
      recurso_afectado: 'salida_almacen',
      id_recurso_afectado: idSalidaGenerado,
      detalles_cambio: {
        mensaje: 'Se generó un nuevo vale de salida maestro.',
        tipo_salida: Tipo_Salida,
        id_autobus: ID_Autobus || null,
        id_vehiculo_particular: ID_Vehiculo_Particular || null,
        solicitado_por: Solicitado_Por_ID,
        kilometraje: Kilometraje_Autobus || null,
        observaciones: Observaciones
      },
      ip_address: req.ip
    });

    res.status(201).json({ id_salida: idSalidaGenerado });

  } catch (error) {
    console.error('Error al guardar el vale maestro de salida:', error);
    res.status(500).json({ message: 'Error en el servidor al registrar el vale.' });
  }
});

// =======================================================
// OBTENER DETALLES DE UN VALE DE SALIDA ESPECÍFICO
// =======================================================
router.get('/detalles/:idSalida', verifyToken, async (req, res) => {
  const { idSalida } = req.params;
  try {
    const query = `
      SELECT id_detalle, id_item, id_lote, nombre_item, numero_parte, cantidad, tipo_item, costo_unitario, cantidad_devuelta FROM (
        SELECT 
          ds.id_detalle_salida as id_detalle, 
          r.id_refaccion as id_item,
          ds.id_lote,
          r.nombre as nombre_item, 
          r.numero_parte as numero_parte,
          ds.cantidad_despachada as cantidad, 
          'refaccion' as tipo_item,
          l.costo_unitario_final as costo_unitario, 
          ds.cantidad_devuelta
        FROM detalle_salida ds
        JOIN lote_refaccion l ON ds.id_lote = l.id_lote
        JOIN refaccion r ON l.id_refaccion = r.id_refaccion
        WHERE ds.id_salida = $1

        UNION ALL

        SELECT 
          dsi.id_detalle_salida_insumo as id_detalle, 
          i.id_insumo as id_item,
          NULL as id_lote,
          i.nombre as nombre_item, 
          'S/N' as numero_parte,
          dsi.cantidad_usada as cantidad, 
          'insumo' as tipo_item,
          dsi.costo_al_momento as costo_unitario, 
          dsi.cantidad_devuelta
        FROM detalle_salida_insumo dsi
        JOIN insumo i ON dsi.id_insumo = i.id_insumo
        WHERE dsi.id_salida = $1
      ) as detalles;
    `;
    const result = await pool.query(query, [idSalida]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener detalles:', error);
    res.status(500).json({ message: 'Error al obtener detalles de la salida' });
  }
});
// =======================================================
// OBTENER HISTORIAL DE VALES CON FILTROS (Paginado)
// =======================================================
router.get('/', verifyToken, async (req, res) => {
  const {
    page = 1,
    limit = 10,
    search = '',
    fechaInicio = '',
    fechaFin = ''
  } = req.query;

  try {
    const params = [];
    let whereClauses = [];

    // --- Construcción de Filtros ---
    if (search.trim()) {
      params.push(`%${search.trim()}%`);
      whereClauses.push(`(
                CAST(s.id_salida AS TEXT) ILIKE $${params.length} OR 
                a.economico ILIKE $${params.length} OR 
                s.tipo_salida ILIKE $${params.length} OR 
                e.nombre ILIKE $${params.length} OR 
                vp.propietario ILIKE $${params.length} OR
                s.observaciones ILIKE $${params.length}
            )`);
    }
    if (fechaInicio) {
      params.push(fechaInicio);
      whereClauses.push(`s.fecha_operacion >= $${params.length}`);
    }
    if (fechaFin) {
      const fechaHasta = new Date(fechaFin);
      fechaHasta.setDate(fechaHasta.getDate() + 1);
      params.push(fechaHasta.toISOString().split('T')[0]);
      whereClauses.push(`s.fecha_operacion < $${params.length}`);
    }

    const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // --- Consulta de Conteo Total ---
    const totalQuery = `
            SELECT COUNT(*) 
            FROM salida_almacen s
            LEFT JOIN autobus a ON s.id_autobus = a.id_autobus
            LEFT JOIN empleado e ON s.solicitado_por_id = e.id_empleado
            LEFT JOIN vehiculos_particulares vp ON s.id_vehiculo_particular = vp.id_vehiculo
            ${whereString}
        `;
    const totalResult = await pool.query(totalQuery, params);
    const totalItems = parseInt(totalResult.rows[0].count, 10);

    // --- Consulta Principal de Datos ---
    const offset = (page - 1) * limit;
    const dataQuery = `
            SELECT
                s.id_salida, s.fecha_operacion, s.tipo_salida, s.observaciones, s.kilometraje_autobus,
                a.economico as economico_autobus,
                e.nombre as nombre_empleado,
                s.id_vehiculo_particular,
                vp.propietario as propietario_vehiculo,
                CONCAT(vp.marca, ' ', vp.modelo) as marca_modelo_vehiculo
            FROM
                salida_almacen s
            LEFT JOIN autobus a ON s.id_autobus = a.id_autobus
            LEFT JOIN empleado e ON s.solicitado_por_id = e.id_empleado
            LEFT JOIN vehiculos_particulares vp ON s.id_vehiculo_particular = vp.id_vehiculo
            ${whereString}
            ORDER BY s.fecha_operacion DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

    const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

    res.json({
      total: totalItems,
      data: dataResult.rows
    });

  } catch (error) {
    console.error("Error al obtener salidas:", error);
    res.status(500).json({ message: 'Error al obtener salidas' });
  }
});

// =======================================================
// EDICIÓN PROFUNDA (CANTIDADES Y STOCK DE SALIDA)
// =======================================================
router.put('/:id/editar-completo', verifyToken, async (req, res) => {
  const { id } = req.params;
  const {
    tipo_salida,
    id_autobus,
    id_vehiculo_particular,
    solicitado_por_id,
    observaciones,
    kilometraje_autobus,
    fecha_operacion,
    items = [] // 🚀 FIX: Valor por defecto para prevenir crash si viene vacío
  } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 🚀 FIX: Resolución segura de nulos respetando el "0" km
    const busId = (id_autobus === '' || id_autobus === undefined) ? null : id_autobus;
    const particularId = (id_vehiculo_particular === '' || id_vehiculo_particular === undefined) ? null : id_vehiculo_particular;
    const km = (kilometraje_autobus === '' || kilometraje_autobus === undefined) ? null : kilometraje_autobus;

    // 1. Actualizar Cabecera
    await client.query(
      `UPDATE salida_almacen 
             SET tipo_salida = $1, id_autobus = $2, id_vehiculo_particular = $3, 
                 solicitado_por_id = $4, observaciones = $5, kilometraje_autobus = $6, fecha_operacion = $7
             WHERE id_salida = $8`,
      [tipo_salida, busId, particularId, solicitado_por_id, observaciones, km, fecha_operacion, id]
    );

    // 2. Procesar Items (Iterar sobre el array enviado)
    for (const item of items) {

      // 🚀 FIX: Compatibilidad de variables entre tu GET y el JSON del Frontend
      const tipoItem = item.tipo_item || item.tipo;
      // Acepta cantidad_nueva o la cantidad normal del JSON
      const cantidadNueva = parseFloat(item.cantidad_nueva ?? item.cantidad);

      if (tipoItem === 'refaccion') {
        const detalleActual = await client.query(
          `SELECT cantidad_despachada, cantidad_devuelta, id_lote 
                     FROM detalle_salida WHERE id_detalle_salida = $1`,
          [item.id_detalle]
        );

        if (detalleActual.rows.length > 0) {
          const detalle = detalleActual.rows[0];
          if (cantidadNueva < detalle.cantidad_devuelta) {
            throw new Error(`No puedes reducir la cantidad a ${cantidadNueva}. Ya se han devuelto ${detalle.cantidad_devuelta} unidades.`);
          }

          const diferenciaCantidad = cantidadNueva - detalle.cantidad_despachada;

          // 🚀 FIX: Usamos el id_lote de la base de datos (detalle.id_lote), no el del item para mayor seguridad
          const loteRes = await client.query(
            `SELECT cantidad_disponible FROM lote_refaccion WHERE id_lote = $1 FOR UPDATE`,
            [detalle.id_lote]
          );
          const lote = loteRes.rows[0];

          if (diferenciaCantidad > 0 && lote.cantidad_disponible < diferenciaCantidad) {
            throw new Error(`Stock insuficiente en el lote. Faltan ${diferenciaCantidad - lote.cantidad_disponible} unidades.`);
          }

          // Actualizar el lote
          await client.query(
            `UPDATE lote_refaccion 
                         SET cantidad_disponible = cantidad_disponible - $1
                         WHERE id_lote = $2`,
            [diferenciaCantidad, detalle.id_lote]
          );

          // Actualizar el detalle
          await client.query(
            `UPDATE detalle_salida SET cantidad_despachada = $1 
                         WHERE id_detalle_salida = $2`,
            [cantidadNueva, item.id_detalle]
          );
        }
      }
      else if (tipoItem === 'insumo') {
        // 🚀 FIX: Extraemos el id_insumo de la BD para usarlo de forma segura
        const detalleActual = await client.query(
          `SELECT id_insumo, cantidad_usada, cantidad_devuelta 
                     FROM detalle_salida_insumo WHERE id_detalle_salida_insumo = $1`,
          [item.id_detalle]
        );

        if (detalleActual.rows.length > 0) {
          const detalle = detalleActual.rows[0];
          if (cantidadNueva < detalle.cantidad_devuelta) {
            throw new Error(`No puedes reducir la cantidad a ${cantidadNueva}. Ya se han devuelto ${detalle.cantidad_devuelta} unidades.`);
          }

          const diferenciaCantidad = cantidadNueva - detalle.cantidad_usada;

          const insumoRes = await client.query(
            `SELECT stock_actual FROM insumo WHERE id_insumo = $1 FOR UPDATE`,
            [detalle.id_insumo]
          );
          const insumo = insumoRes.rows[0];

          if (diferenciaCantidad > 0 && insumo.stock_actual < diferenciaCantidad) {
            throw new Error(`Stock insuficiente. Faltan ${diferenciaCantidad - insumo.stock_actual} unidades.`);
          }

          // Actualizar stock del insumo
          await client.query(
            `UPDATE insumo 
                         SET stock_actual = stock_actual - $1
                         WHERE id_insumo = $2`,
            [diferenciaCantidad, detalle.id_insumo]
          );

          // Actualizar el detalle
          await client.query(
            `UPDATE detalle_salida_insumo SET cantidad_usada = $1 
                         WHERE id_detalle_salida_insumo = $2`,
            [cantidadNueva, item.id_detalle]
          );
        }
      }
    }

    await client.query('COMMIT');

    // 🛡️ AUDITORÍA DE EDICIÓN PROFUNDA
    registrarAuditoria({
      id_usuario: req.user.id,
      tipo_accion: 'ACTUALIZAR',
      recurso_afectado: 'salida_almacen_completa',
      id_recurso_afectado: id,
      detalles_cambio: {
        mensaje: 'Se realizó una EDICIÓN PROFUNDA a la salida, recalibrando existencias en inventario.',
        items_afectados: items.length
      },
      ip_address: req.ip
    });

    res.json({ message: 'Salida actualizada y stock ajustado correctamente.' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error edición histórica salida:', error);
    // Devolvemos el mensaje del error exacto para que el frontend lo muestre (Ej: "Stock insuficiente")
    res.status(400).json({ message: error.message || 'Ocurrió un error al editar la salida.' });
  } finally {
    client.release();
  }
});

module.exports = router;