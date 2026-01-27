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
    const {
        page = 1,
        limit = 15,
        search = '',
        tipo_ajuste = '',
        fecha_desde = '',
        fecha_hasta = ''
    } = req.query;

    try {
        const params = [];
        let whereClauses = [];

        // Filtro de búsqueda
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            // CORRECCIÓN: Usa 'e.nombre'
            whereClauses.push(`(e.nombre ILIKE $${params.length} OR aim.motivo ILIKE $${params.length})`);
        }

        // Filtro por tipo de ajuste
        if (tipo_ajuste) {
            params.push(tipo_ajuste);
            whereClauses.push(`aim.tipo_ajuste = $${params.length}`);
        }

        // Filtro de fecha desde
        if (fecha_desde) {
            params.push(fecha_desde);
            // CORRECCIÓN: Usa 'fecha_ajuste'
            whereClauses.push(`aim.fecha_ajuste >= $${params.length}::timestamp`);
        }

        // Filtro de fecha hasta
        if (fecha_hasta) {
            params.push(fecha_hasta + ' 23:59:59');
            // CORRECCIÓN: Usa 'fecha_ajuste'
            whereClauses.push(`aim.fecha_ajuste <= $${params.length}::timestamp`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Contar total
        const totalQuery = `
SELECT COUNT(*) as count
FROM ajuste_inventario_maestro AS aim
LEFT JOIN empleado AS e ON aim.id_empleado = e.id_empleado
${whereString}
`.trim();
        console.log('🧩 Consulta generada:\n', totalQuery, '\n🧩 Parámetros:', params);
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // Obtener datos paginados
        const offset = (page - 1) * limit;
        const dataQuery = `
SELECT 
    aim.id_ajuste,
    aim.id_empleado,
    aim.fecha_ajuste,
    aim.fecha_ajuste AS fecha_creacion,
    aim.tipo_ajuste,
    aim.motivo,
    e.nombre AS nombre_empleado,
    (SELECT COUNT(*) FROM ajuste_inventario_detalle WHERE id_ajuste = aim.id_ajuste) AS total_detalles
FROM ajuste_inventario_maestro AS aim
LEFT JOIN empleado AS e ON aim.id_empleado = e.id_empleado
${whereString}
ORDER BY aim.fecha_ajuste DESC
LIMIT $${params.length + 1} OFFSET $${params.length + 2}
`.trim();

        console.log('🧩 Consulta generada:\n', totalQuery, '\n🧩 Parámetros:', params);
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

        res.json({
            total: totalItems,
            data: dataResult.rows
        });

    } catch (error) {
        console.error('Error al obtener ajustes:', error);
        res.status(500).json({
            message: 'Error al obtener ajustes',
            error: error.message
        });
    }
});
router.get('/inventario-global', verifyToken, async (req, res) => {
    const { search = '', page = 1, limit = 10 } = req.query;
    
    try {
        const searchTerm = `%${search}%`;
        const offset = (page - 1) * limit;

        // 1. Consulta Base (La usamos para contar y para traer datos)
        // Usamos una CTE (Common Table Expression) para limpiar el código
        const baseQuery = `
            WITH inventario_unificado AS (
                SELECT 
                    r.id_refaccion as id, 
                    r.nombre, 
                    r.marca, 
                    'Refacción' as tipo, 
                    COALESCE((SELECT SUM(l.cantidad_disponible) FROM lote_refaccion l WHERE l.id_refaccion = r.id_refaccion), 0) as stock_actual,
                    r.unidad_medida as unidad
                FROM refaccion r
                UNION ALL
                SELECT 
                    id_insumo as id, 
                    nombre, 
                    marca, 
                    'Insumo' as tipo, 
                    stock_actual, 
                    unidad_medida as unidad
                FROM insumo
            )
            SELECT * FROM inventario_unificado
            WHERE nombre ILIKE $1 OR marca ILIKE $1
        `;

        // 2. Obtener Total de Registros (Para la paginación)
        const countQuery = `SELECT COUNT(*) FROM (${baseQuery}) as total`;
        const countResult = await pool.query(countQuery, [searchTerm]);
        const totalItems = parseInt(countResult.rows[0].count, 10);

        // 3. Obtener Datos Paginados
        const dataQuery = `
            ${baseQuery}
            ORDER BY nombre ASC
            LIMIT $2 OFFSET $3
        `;
        const dataResult = await pool.query(dataQuery, [searchTerm, limit, offset]);

        res.json({
            data: dataResult.rows,
            total: totalItems
        });

    } catch (error) {
        console.error('Error SQL en inventario-global:', error);
        res.status(500).json({ message: 'Error al obtener inventario global.' });
    }
});

// ======================================================================
// 2. APLICAR AJUSTE (Lógica Compleja para Refacciones vs Insumos)
// ======================================================================
router.post('/aplicar', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id, tipo, stock_fisico, motivo } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        let diferencia = 0;
        let stockSistema = 0;

        // CASO A: ES UN INSUMO (Fácil, tiene columna)
        if (tipo === 'Insumo') {
            const actualRes = await client.query('SELECT stock_actual FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id]);
            if (actualRes.rows.length === 0) throw new Error('Insumo no encontrado');
            
            stockSistema = parseFloat(actualRes.rows[0].stock_actual);
            diferencia = stock_fisico - stockSistema;

            if (diferencia !== 0) {
                await client.query('UPDATE insumo SET stock_actual = $1 WHERE id_insumo = $2', [stock_fisico, id]);
            }
        } 
        
        // CASO B: ES UNA REFACCIÓN (Difícil, usa lotes)
        else if (tipo === 'Refacción') {
            // 1. Calcular stock actual sumando lotes existentes
            const stockRes = await client.query(
                `SELECT COALESCE(SUM(cantidad_disponible), 0) as total 
                 FROM lote_refaccion WHERE id_refaccion = $1`, 
                [id]
            );
            stockSistema = parseFloat(stockRes.rows[0].total);
            diferencia = stock_fisico - stockSistema;

            if (diferencia > 0) {
                // SOBRA MATERIAL (Entrada): Creamos un "Lote de Ajuste"
                await client.query(
                    `INSERT INTO lote_refaccion (id_refaccion, cantidad_inicial, cantidad_disponible, costo_unitario_final, numero_lote)
                     VALUES ($1, $2, $2, 0, 'AJUSTE-2026')`, 
                    [id, diferencia]
                );
            } else if (diferencia < 0) {
                // FALTA MATERIAL (Salida): Restar de lotes existentes (FIFO)
                let cantidadARestar = Math.abs(diferencia);
                
                // CORRECCIÓN AQUÍ: Cambiado 'id_lote_refaccion' por 'id_lote'
                const lotesRes = await client.query(
                    `SELECT id_lote, cantidad_disponible 
                     FROM lote_refaccion 
                     WHERE id_refaccion = $1 AND cantidad_disponible > 0 
                     ORDER BY id_lote ASC`, 
                    [id]
                );

                for (const lote of lotesRes.rows) {
                    if (cantidadARestar <= 0) break;

                    const disponible = parseFloat(lote.cantidad_disponible);
                    let restarDelLote = 0;

                    if (disponible >= cantidadARestar) {
                        // Este lote cubre todo
                        restarDelLote = cantidadARestar;
                        cantidadARestar = 0;
                    } else {
                        // Se acaba este lote y seguimos con el siguiente
                        restarDelLote = disponible;
                        cantidadARestar -= disponible;
                    }

                    // CORRECCIÓN AQUÍ: Usamos 'id_lote' en el UPDATE
                    await client.query(
                        `UPDATE lote_refaccion 
                         SET cantidad_disponible = cantidad_disponible - $1 
                         WHERE id_lote = $2`,
                        [restarDelLote, lote.id_lote]
                    );
                }
            }
        }

        if (diferencia === 0) {
            await client.query('ROLLBACK');
            return res.json({ message: 'Sin cambios. El stock físico coincide con el sistema.' });
        }

        console.log(`AJUSTE APLICADO | ${tipo} ID:${id} | Sistema: ${stockSistema} -> Físico: ${stock_fisico} | Dif: ${diferencia}`);

        await client.query('COMMIT');
        res.json({ 
            message: 'Inventario ajustado correctamente.', 
            diferencia: diferencia,
            nuevo_stock: stock_fisico 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en ajuste:', error);
        res.status(500).json({ message: 'Error al procesar el ajuste.', error: error.message });
    } finally {
        client.release();
    }
});

// ============================================
// GET /detalle/:id - Obtener detalle completo de un ajuste
// ============================================
router.get('/detalle/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;

    try {
        // Obtener datos maestros
        const maestroQuery = `
            SELECT 
                aim.id_ajuste,
                aim.id_empleado,
                aim.fecha_ajuste,
                aim.fecha_ajuste AS fecha_creacion, -- AJUSTE: Alias para el frontend
                aim.tipo_ajuste,
                aim.motivo,
                e.nombre as nombre_empleado -- AJUSTE: Usa e.nombre
            FROM ajuste_inventario_maestro aim
            LEFT JOIN empleado e ON aim.id_empleado = e.id_empleado
            WHERE aim.id_ajuste = $1
        `;
        console.log('🧩 Consulta generada:\n', totalQuery, '\n🧩 Parámetros:', params);
        const maestroResult = await pool.query(maestroQuery, [id]);

        if (maestroResult.rows.length === 0) {
            return res.status(404).json({
                error: 'Ajuste no encontrado',
                message: `No se encontró un ajuste con el ID ${id}`
            });
        }

        const maestro = maestroResult.rows[0];

        // Obtener detalles
        const detallesQuery = `
            SELECT 
                aid.*,
                COALESCE(r.nombre_refaccion, i.nombre_insumo) as nombre_item
            FROM ajuste_inventario_detalle aid
            LEFT JOIN refaccion r ON aid.id_refaccion = r.id_refaccion
            LEFT JOIN insumo i ON aid.id_insumo = i.id_insumo
            WHERE aid.id_ajuste = $1
            ORDER BY aid.id_detalle
        `;
        console.log('🧩 Consulta generada:\n', totalQuery, '\n🧩 Parámetros:', params);
        const detallesResult = await pool.query(detallesQuery, [id]);

        res.json({
            ...maestro,
            detalles: detallesResult.rows
        });

    } catch (error) {
        console.error('Error al obtener detalle del ajuste:', error);
        res.status(500).json({
            error: 'Error en el servidor',
            message: error.message
        });
    }
});

// ============================================
// POST / - Crear nuevo ajuste
// ============================================
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {

    const { maestro, detalles } = req.body;
    const { id_empleado, tipo_ajuste, motivo } = maestro;

    if (!id_empleado || !tipo_ajuste || !motivo || !detalles || detalles.length === 0) {
        return res.status(400).json({ message: 'Datos maestros (empleado, tipo, motivo) y detalles son requeridos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Crear el Ajuste Maestro
        // AJUSTE: Se usa 'fecha_ajuste' de la DB, se quita del insert
        const maestroResult = await client.query(
            `INSERT INTO ajuste_inventario_maestro (id_empleado, tipo_ajuste, motivo, fecha_ajuste)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP) RETURNING id_ajuste`,
            [id_empleado, tipo_ajuste, motivo]
        );
        const nuevoAjusteId = maestroResult.rows[0].id_ajuste;

        // 2. Procesar cada detalle
        // AJUSTE: Lógica mejorada para capturar el ID de lote en ENTRADA
        for (const detalle of detalles) {

            let idLoteParaGuardar = detalle.id_lote || null; // El ID del lote del frontend

            // Aplicar lógica de negocio
            if (detalle.id_insumo) {
                // INSUMO
                await client.query(
                    'UPDATE insumo SET stock_actual = stock_actual + $1 WHERE id_insumo = $2',
                    [detalle.cantidad, detalle.id_insumo]
                );
            } else if (detalle.id_refaccion) {
                // REFACCIÓN
                if (tipo_ajuste === 'ENTRADA') {
                    // AJUSTE: Crear lote y OBTENER su ID
                    const loteResult = await client.query(
                        `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario)
                         VALUES ($1, $2, $3, $3, 0) RETURNING id_lote_refaccion`,
                        [detalle.id_refaccion, detalle.cantidad, detalle.costo_ajuste || 0]
                    );
                    idLoteParaGuardar = loteResult.rows[0].id_lote_refaccion; // Guardar el ID del nuevo lote

                } else if (tipo_ajuste === 'SALIDA') {
                    // AJUSTE: Usar 'detalle.id_lote' (del frontend)
                    await client.query(
                        'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote_refaccion = $2',
                        [Math.abs(detalle.cantidad), detalle.id_lote]
                    );
                } else if (tipo_ajuste === 'REVALORIZACION') {
                    // AJUSTE: Usar 'detalle.id_lote' (del frontend)
                    await client.query(
                        'UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final + $1 WHERE id_lote_refaccion = $2',
                        [detalle.costo_ajuste, detalle.id_lote]
                    );
                }
            }

            // Insertar detalle
            // AJUSTE: Se usa 'idLoteParaGuardar' que ahora tiene el ID correcto
            await client.query(
                `INSERT INTO ajuste_inventario_detalle (id_ajuste, id_refaccion, id_insumo, id_lote_refaccion, cantidad, costo_ajuste)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [nuevoAjusteId, detalle.id_refaccion, detalle.id_insumo, idLoteParaGuardar, detalle.cantidad, detalle.costo_ajuste]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ id_ajuste: nuevoAjusteId, message: 'Ajuste de inventario creado exitosamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de ajuste de inventario:', error);
        res.status(500).json({ message: 'Error al procesar el ajuste de inventario.' });
    } finally {
        client.release();
    }
});

// ============================================
// PUT /:id - Actualizar ajuste existente
// ============================================
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { maestro, detalles } = req.body;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Obtener datos originales
        const originalQuery = `
            SELECT aim.*, 
                   array_agg(
                       json_build_object(
                           'id_detalle', aid.id_detalle,
                           'id_refaccion', aid.id_refaccion,
                           'id_insumo', aid.id_insumo,
                           'id_lote_refaccion', aid.id_lote_refaccion,
                           'cantidad', aid.cantidad,
                           'costo_ajuste', aid.costo_ajuste
                       )
                   ) as detalles_originales
            FROM ajuste_inventario_maestro aim
            LEFT JOIN ajuste_inventario_detalle aid ON aim.id_ajuste = aid.id_ajuste
            WHERE aim.id_ajuste = $1
            GROUP BY aim.id_ajuste
        `;
        const originalResult = await client.query(originalQuery, [id]);

        if (originalResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                error: 'Ajuste no encontrado'
            });
        }

        const ajusteOriginal = originalResult.rows[0];

        // 2. REVERTIR el ajuste original
        console.log('⏪ Revirtiendo ajuste original...');
        for (const detalleOrig of ajusteOriginal.detalles_originales) {
            if (!detalleOrig.id_detalle) continue; // Skip null entries

            if (detalleOrig.id_insumo) {
                // Revertir insumo (restar la cantidad que se había sumado/restado)
                await client.query(
                    'UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2',
                    [detalleOrig.cantidad, detalleOrig.id_insumo]
                );
            } else if (detalleOrig.id_refaccion) {
                if (ajusteOriginal.tipo_ajuste === 'ENTRADA') {
                    // AJUSTE: Si fue entrada, ELIMINAR el lote que se creó
                    // (Asumiendo que el lote no se ha usado, lo cual es un riesgo de negocio
                    // pero es la única forma de revertir)
                    if (detalleOrig.id_lote_refaccion) {
                        await client.query(
                            'DELETE FROM lote_refaccion WHERE id_lote_refaccion = $1',
                            [detalleOrig.id_lote_refaccion]
                        );
                    }
                } else if (ajusteOriginal.tipo_ajuste === 'SALIDA') {
                    // Si fue salida, devolver al lote
                    await client.query(
                        'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible + $1 WHERE id_lote_refaccion = $2',
                        [Math.abs(detalleOrig.cantidad), detalleOrig.id_lote_refaccion]
                    );
                } else if (ajusteOriginal.tipo_ajuste === 'REVALORIZACION') {
                    // Revertir el ajuste de costo
                    await client.query(
                        'UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final - $1 WHERE id_lote_refaccion = $2',
                        [detalleOrig.costo_ajuste, detalleOrig.id_lote_refaccion]
                    );
                }
            }
        }

        // 3. Actualizar maestro
        await client.query(
            `UPDATE ajuste_inventario_maestro 
             SET id_empleado = $1, tipo_ajuste = $2, motivo = $3
             WHERE id_ajuste = $4`,
            [maestro.id_empleado, maestro.tipo_ajuste, maestro.motivo, id]
        );

        // 4. Eliminar detalles antiguos
        await client.query('DELETE FROM ajuste_inventario_detalle WHERE id_ajuste = $1', [id]);

        // 5. Insertar nuevos detalles y aplicar nuevos ajustes
        // AJUSTE: Lógica copiada del POST, ahora correcta
        console.log('⏩ Aplicando nuevos ajustes...');
        for (const detalle of detalles) {

            let idLoteParaGuardar = detalle.id_lote || null;

            if (detalle.id_insumo) {
                await client.query(
                    'UPDATE insumo SET stock_actual = stock_actual + $1 WHERE id_insumo = $2',
                    [detalle.cantidad, detalle.id_insumo]
                );
            } else if (detalle.id_refaccion) {
                if (maestro.tipo_ajuste === 'ENTRADA') {
                    const loteResult = await client.query(
                        `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario)
                         VALUES ($1, $2, $3, $3, 0) RETURNING id_lote_refaccion`,
                        [detalle.id_refaccion, detalle.cantidad, detalle.costo_ajuste || 0]
                    );
                    idLoteParaGuardar = loteResult.rows[0].id_lote_refaccion;

                } else if (maestro.tipo_ajuste === 'SALIDA') {
                    await client.query(
                        'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote_refaccion = $2',
                        [Math.abs(detalle.cantidad), detalle.id_lote]
                    );
                    _
                } else if (maestro.tipo_ajuste === 'REVALORIZACION') {
                    await client.query(
                        'UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final + $1 WHERE id_lote_refaccion = $2',
                        [detalle.costo_ajuste, detalle.id_lote]
                    );
                }
            }

            // Insertar detalle nuevo
            await client.query(
                `INSERT INTO ajuste_inventario_detalle (id_ajuste, id_refaccion, id_insumo, id_lote_refaccion, cantidad, costo_ajuste)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, detalle.id_refaccion, detalle.id_insumo, idLoteParaGuardar, detalle.cantidad, detalle.costo_ajuste]
            );
        }

        await client.query('COMMIT');
        res.json({
            message: 'Ajuste actualizado exitosamente. El inventario ha sido recalculado.',
            id_ajuste: id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Error al actualizar ajuste:', error);
        res.status(500).json({
            error: 'Error en el servidor',
            message: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router;