const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();

// ============================================
// GET / - Listar ajustes con paginación y filtros
// ============================================
router.get('/', verifyToken, async (req, res) => {
    const { page = 1, limit = 15, search = '', tipo_ajuste = '', fecha_desde = '', fecha_hasta = '' } = req.query;

    try {
        const params = [];
        let whereClauses = [];

        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(e.nombre ILIKE $${params.length} OR aim.motivo ILIKE $${params.length})`);
        }
        if (tipo_ajuste) {
            params.push(tipo_ajuste);
            whereClauses.push(`aim.tipo_ajuste = $${params.length}`);
        }
        if (fecha_desde) {
            params.push(fecha_desde);
            whereClauses.push(`aim.fecha_ajuste >= $${params.length}::timestamp`);
        }
        if (fecha_hasta) {
            params.push(fecha_hasta + ' 23:59:59');
            whereClauses.push(`aim.fecha_ajuste <= $${params.length}::timestamp`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const totalQuery = `SELECT COUNT(*) as count FROM ajuste_inventario_maestro AS aim LEFT JOIN empleado AS e ON aim.id_empleado = e.id_empleado ${whereString}`.trim();
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT aim.id_ajuste, aim.id_empleado, aim.fecha_ajuste, aim.fecha_ajuste AS fecha_creacion, aim.tipo_ajuste, aim.motivo, e.nombre AS nombre_empleado,
            (SELECT COUNT(*) FROM ajuste_inventario_detalle WHERE id_ajuste = aim.id_ajuste) AS total_detalles
            FROM ajuste_inventario_maestro AS aim LEFT JOIN empleado AS e ON aim.id_empleado = e.id_empleado
            ${whereString} ORDER BY aim.fecha_ajuste DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `.trim();

        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        res.json({ total: totalItems, data: dataResult.rows });
    } catch (error) {
        console.error('Error al obtener ajustes:', error);
        res.status(500).json({ message: 'Error al obtener ajustes', error: error.message });
    }
});

// ============================================
// GET /inventario-global - Obtener items
// ============================================
router.get('/inventario-global', verifyToken, async (req, res) => {
    const { search = '', page = 1, limit = 10 } = req.query;
    try {
        const searchTerm = `%${search}%`;
        const offset = (page - 1) * limit;

        const baseQuery = `
            WITH inventario_unificado AS (
                -- 1. REFACCIONES
                SELECT r.id_refaccion as id, r.nombre, r.marca, 'Refacción' as tipo, 
                COALESCE((SELECT SUM(l.cantidad_disponible) FROM lote_refaccion l WHERE l.id_refaccion = r.id_refaccion), 0) as stock_actual,
                r.unidad_medida as unidad, r.numero_parte, r.categoria,
                COALESCE((SELECT l.costo_unitario_final FROM lote_refaccion l WHERE l.id_refaccion = r.id_refaccion ORDER BY l.fecha_ingreso DESC, l.id_lote DESC LIMIT 1), 0) as ultimo_costo
                FROM refaccion r
                UNION ALL
                -- 2. INSUMOS
                SELECT id_insumo as id, nombre, marca, 'Insumo' as tipo, stock_actual, unidad_medida as unidad, '---' as numero_parte, tipo_insumo::text as categoria,
                COALESCE(costo_unitario_promedio, 0) as ultimo_costo -- AQUI USAMOS EL NOMBRE CORRECTO
                FROM insumo
            )
            SELECT * FROM inventario_unificado WHERE nombre ILIKE $1 OR marca ILIKE $1 OR numero_parte ILIKE $1
        `;

        const countResult = await pool.query(`SELECT COUNT(*) FROM (${baseQuery}) as total`, [searchTerm]);
        const totalItems = parseInt(countResult.rows[0].count, 10);
        const dataResult = await pool.query(`${baseQuery} ORDER BY nombre ASC LIMIT $2 OFFSET $3`, [searchTerm, limit, offset]);

        res.json({ data: dataResult.rows, total: totalItems });
    } catch (error) {
        console.error('Error SQL en inventario-global:', error);
        res.status(500).json({ message: 'Error al obtener inventario global.' });
    }
});

// ============================================
// POST /aplicar - Crear o modificar ajuste
// ============================================
router.post('/aplicar', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id, tipo, stock_fisico, costo_unitario, motivo } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        let diferencia = 0; let stockSistema = 0;

        if (tipo === 'Insumo') {
            // USAMOS EL NOMBRE CORRECTO AQUÍ
            const actualRes = await client.query('SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id]);
            if (actualRes.rows.length === 0) throw new Error('Insumo no encontrado');
            
            stockSistema = parseFloat(actualRes.rows[0].stock_actual);
            const costoSistema = parseFloat(actualRes.rows[0].costo_unitario_promedio || 0);
            diferencia = stock_fisico - stockSistema;

            if (diferencia !== 0 || costo_unitario !== costoSistema) {
                await client.query(
                    'UPDATE insumo SET stock_actual = $1, costo_unitario_promedio = $2 WHERE id_insumo = $3', 
                    [stock_fisico, costo_unitario, id]
                );
            }
        } 
        else if (tipo === 'Refacción') {
            const stockRes = await client.query(`SELECT COALESCE(SUM(cantidad_disponible), 0) as total FROM lote_refaccion WHERE id_refaccion = $1`, [id]);
            stockSistema = parseFloat(stockRes.rows[0].total);
            diferencia = stock_fisico - stockSistema;

            if (diferencia > 0) {
                await client.query(
                    `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario, fecha_ingreso) VALUES ($1, $2, $3, $4, 0, CURRENT_DATE)`, 
                    [id, diferencia, costo_unitario, (costo_unitario * diferencia)]
                );
            } else if (diferencia < 0) {
                let cantidadARestar = Math.abs(diferencia);
                const lotesRes = await client.query(`SELECT id_lote, cantidad_disponible FROM lote_refaccion WHERE id_refaccion = $1 AND cantidad_disponible > 0 ORDER BY id_lote ASC`, [id]);
                
                for (const lote of lotesRes.rows) {
                    if (cantidadARestar <= 0) break;
                    const disponible = parseFloat(lote.cantidad_disponible);
                    let restarDelLote = 0;
                    if (disponible >= cantidadARestar) { restarDelLote = cantidadARestar; cantidadARestar = 0; } 
                    else { restarDelLote = disponible; cantidadARestar -= disponible; }
                    await client.query(`UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2`, [restarDelLote, lote.id_lote]);
                }
            } else if (diferencia === 0) {
                 const ultimoLoteRes = await client.query(`SELECT id_lote FROM lote_refaccion WHERE id_refaccion = $1 ORDER BY fecha_ingreso DESC, id_lote DESC LIMIT 1`, [id]);
                if(ultimoLoteRes.rows.length > 0) {
                     await client.query(`UPDATE lote_refaccion SET costo_unitario_final = $1 WHERE id_lote = $2`, [costo_unitario, ultimoLoteRes.rows[0].id_lote]);
                } else {
                     await client.query(`INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario, fecha_ingreso) VALUES ($1, 0, $2, 0, 0, CURRENT_DATE)`, [id, costo_unitario]);
                }
            }
        }

        console.log(`AJUSTE | ${tipo} ID:${id} | Sist: ${stockSistema} -> Fís: ${stock_fisico} | Dif: ${diferencia} | Costo: ${costo_unitario}`);
        await client.query('COMMIT');
        res.json({ message: 'Inventario ajustado correctamente.', diferencia: diferencia, nuevo_stock: stock_fisico, nuevo_costo: costo_unitario });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en ajuste:', error);
        res.status(500).json({ message: 'Error al procesar el ajuste.', error: error.message });
    } finally {
        client.release();
    }
});

// ============================================
// GET /detalle/:id - Obtener detalle
// ============================================
router.get('/detalle/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    try {
        const maestroResult = await pool.query(`SELECT aim.id_ajuste, aim.id_empleado, aim.fecha_ajuste, aim.fecha_ajuste AS fecha_creacion, aim.tipo_ajuste, aim.motivo, e.nombre as nombre_empleado FROM ajuste_inventario_maestro aim LEFT JOIN empleado e ON aim.id_empleado = e.id_empleado WHERE aim.id_ajuste = $1`, [id]);
        if (maestroResult.rows.length === 0) return res.status(404).json({ error: 'Ajuste no encontrado' });
        
        const detallesResult = await pool.query(`SELECT aid.*, COALESCE(r.nombre, i.nombre) as nombre_item FROM ajuste_inventario_detalle aid LEFT JOIN refaccion r ON aid.id_refaccion = r.id_refaccion LEFT JOIN insumo i ON aid.id_insumo = i.id_insumo WHERE aid.id_ajuste = $1 ORDER BY aid.id_detalle`, [id]);
        res.json({ ...maestroResult.rows[0], detalles: detallesResult.rows });
    } catch (error) {
        console.error('Error al obtener detalle:', error);
        res.status(500).json({ error: 'Error en el servidor', message: error.message });
    }
});

// ============================================
// POST / - Crear ajuste complejo (Múltiples items)
// ============================================
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { maestro, detalles } = req.body;
    if (!maestro.id_empleado || !maestro.tipo_ajuste || !maestro.motivo || !detalles || detalles.length === 0) return res.status(400).json({ message: 'Faltan datos.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const maestroResult = await client.query(`INSERT INTO ajuste_inventario_maestro (id_empleado, tipo_ajuste, motivo, fecha_ajuste) VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING id_ajuste`, [maestro.id_empleado, maestro.tipo_ajuste, maestro.motivo]);
        const nuevoAjusteId = maestroResult.rows[0].id_ajuste;

        for (const detalle of detalles) {
            let idLoteParaGuardar = detalle.id_lote || null;

            if (detalle.id_insumo) {
                await client.query('UPDATE insumo SET stock_actual = stock_actual + $1 WHERE id_insumo = $2', [detalle.cantidad, detalle.id_insumo]);
            } else if (detalle.id_refaccion) {
                if (maestro.tipo_ajuste === 'ENTRADA') {
                    const loteResult = await client.query(`INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario, fecha_ingreso) VALUES ($1, $2, $3, $3, 0, CURRENT_DATE) RETURNING id_lote`, [detalle.id_refaccion, detalle.cantidad, detalle.costo_ajuste || 0]);
                    idLoteParaGuardar = loteResult.rows[0].id_lote;
                } else if (maestro.tipo_ajuste === 'SALIDA') {
                    await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2', [Math.abs(detalle.cantidad), detalle.id_lote]);
                } else if (maestro.tipo_ajuste === 'REVALORIZACION') {
                    await client.query('UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final + $1 WHERE id_lote = $2', [detalle.costo_ajuste, detalle.id_lote]);
                }
            }

            await client.query(`INSERT INTO ajuste_inventario_detalle (id_ajuste, id_refaccion, id_insumo, id_lote_refaccion, cantidad, costo_ajuste) VALUES ($1, $2, $3, $4, $5, $6)`, [nuevoAjusteId, detalle.id_refaccion, detalle.id_insumo, idLoteParaGuardar, detalle.cantidad, detalle.costo_ajuste]);
        }

        await client.query('COMMIT');
        res.status(201).json({ id_ajuste: nuevoAjusteId, message: 'Ajuste creado exitosamente.' });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error al procesar el ajuste.', error: error.message });
    } finally {
        client.release();
    }
});

// ============================================
// PUT /:id - Actualizar ajuste complejo
// ============================================
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params; const { maestro, detalles } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const originalResult = await client.query(`SELECT aim.*, array_agg(json_build_object('id_detalle', aid.id_detalle, 'id_refaccion', aid.id_refaccion, 'id_insumo', aid.id_insumo, 'id_lote_refaccion', aid.id_lote_refaccion, 'cantidad', aid.cantidad, 'costo_ajuste', aid.costo_ajuste)) as detalles_originales FROM ajuste_inventario_maestro aim LEFT JOIN ajuste_inventario_detalle aid ON aim.id_ajuste = aid.id_ajuste WHERE aim.id_ajuste = $1 GROUP BY aim.id_ajuste`, [id]);
        if (originalResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Ajuste no encontrado' }); }

        const ajusteOriginal = originalResult.rows[0];

        // REVERTIR
        for (const det of ajusteOriginal.detalles_originales) {
            if (!det.id_detalle) continue;
            if (det.id_insumo) {
                await client.query('UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2', [det.cantidad, det.id_insumo]);
            } else if (det.id_refaccion) {
                if (ajusteOriginal.tipo_ajuste === 'ENTRADA' && det.id_lote_refaccion) {
                    await client.query('DELETE FROM lote_refaccion WHERE id_lote = $1', [det.id_lote_refaccion]);
                } else if (ajusteOriginal.tipo_ajuste === 'SALIDA') {
                    await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible + $1 WHERE id_lote = $2', [Math.abs(det.cantidad), det.id_lote_refaccion]);
                } else if (ajusteOriginal.tipo_ajuste === 'REVALORIZACION') {
                    await client.query('UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final - $1 WHERE id_lote = $2', [det.costo_ajuste, det.id_lote_refaccion]);
                }
            }
        }

        await client.query(`UPDATE ajuste_inventario_maestro SET id_empleado = $1, tipo_ajuste = $2, motivo = $3 WHERE id_ajuste = $4`, [maestro.id_empleado, maestro.tipo_ajuste, maestro.motivo, id]);
        await client.query('DELETE FROM ajuste_inventario_detalle WHERE id_ajuste = $1', [id]);

        // APLICAR
        for (const detalle of detalles) {
            let idLoteParaGuardar = detalle.id_lote || null;
            if (detalle.id_insumo) {
                await client.query('UPDATE insumo SET stock_actual = stock_actual + $1 WHERE id_insumo = $2', [detalle.cantidad, detalle.id_insumo]);
            } else if (detalle.id_refaccion) {
                if (maestro.tipo_ajuste === 'ENTRADA') {
                    const loteResult = await client.query(`INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario, fecha_ingreso) VALUES ($1, $2, $3, $3, 0, CURRENT_DATE) RETURNING id_lote`, [detalle.id_refaccion, detalle.cantidad, detalle.costo_ajuste || 0]);
                    idLoteParaGuardar = loteResult.rows[0].id_lote;
                } else if (maestro.tipo_ajuste === 'SALIDA') {
                    await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2', [Math.abs(detalle.cantidad), detalle.id_lote]);
                } else if (maestro.tipo_ajuste === 'REVALORIZACION') {
                    await client.query('UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final + $1 WHERE id_lote = $2', [detalle.costo_ajuste, detalle.id_lote]);
                }
            }
            await client.query(`INSERT INTO ajuste_inventario_detalle (id_ajuste, id_refaccion, id_insumo, id_lote_refaccion, cantidad, costo_ajuste) VALUES ($1, $2, $3, $4, $5, $6)`, [id, detalle.id_refaccion, detalle.id_insumo, idLoteParaGuardar, detalle.cantidad, detalle.costo_ajuste]);
        }

        await client.query('COMMIT');
        res.json({ message: 'Ajuste actualizado.', id_ajuste: id });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Error en el servidor', message: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;