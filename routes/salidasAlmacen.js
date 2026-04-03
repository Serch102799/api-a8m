// routes/salidaAlmacen.js
const express = require('express');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
// const checkRole = require('../middleware/checkRole'); // Descomentar si lo usas
const router = express.Router();



router.post('/', async (req, res) => {
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
    
    res.status(201).json({ id_salida: result.rows[0].id_salida });

  } catch (error) {
    console.error('Error al guardar el vale maestro de salida:', error);
    res.status(500).json({ message: 'Error en el servidor al registrar el vale.' });
  }
});


router.get('/detalles/:idSalida', verifyToken, async (req, res) => {
  const { idSalida } = req.params;
  try {
    const query = `
      SELECT id_detalle, nombre_item, cantidad, tipo_item, costo_unitario, cantidad_devuelta FROM (
        SELECT 
          ds.id_detalle_salida as id_detalle, r.nombre as nombre_item, 
          ds.cantidad_despachada as cantidad, 'refaccion' as tipo_item,
          l.costo_unitario_final as costo_unitario, ds.cantidad_devuelta
        FROM detalle_salida ds
        JOIN lote_refaccion l ON ds.id_lote = l.id_lote
        JOIN refaccion r ON l.id_refaccion = r.id_refaccion
        WHERE ds.id_salida = $1

        UNION ALL

        SELECT 
          dsi.id_detalle_salida_insumo as id_detalle, i.nombre as nombre_item, 
          dsi.cantidad_usada as cantidad, 'insumo' as tipo_item,
          dsi.costo_al_momento as costo_unitario, dsi.cantidad_devuelta
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
            // Ahora sí, busca correctamente en el campo 'propietario' de la tabla 'vehiculos_particulares'
            whereClauses.push(`(a.economico ILIKE $${params.length} OR s.tipo_salida ILIKE $${params.length} OR e.nombre ILIKE $${params.length} OR vp.propietario ILIKE $${params.length})`);
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
        // CORREGIDO: LEFT JOIN a vehiculos_particulares
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

module.exports = router;