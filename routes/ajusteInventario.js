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
            whereClauses.push(`(e.nombre_completo ILIKE $${params.length} OR aim.motivo ILIKE $${params.length})`);
        }

        // Filtro por tipo de ajuste
        if (tipo_ajuste) {
            params.push(tipo_ajuste);
            whereClauses.push(`aim.tipo_ajuste = $${params.length}`);
        }

        // Filtro de fecha desde
        if (fecha_desde) {
            params.push(fecha_desde);
            whereClauses.push(`aim.fecha_creacion >= $${params.length}::timestamp`);
        }

        // Filtro de fecha hasta
        if (fecha_hasta) {
            params.push(fecha_hasta + ' 23:59:59');
            whereClauses.push(`aim.fecha_creacion <= $${params.length}::timestamp`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Contar total
        const totalQuery = `
            SELECT COUNT(*) as count
            FROM ajuste_inventario_maestro aim
            LEFT JOIN empleado e ON aim.id_empleado = e.id_empleado
            ${whereString}
        `;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // Obtener datos paginados
        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT 
                aim.*,
                e.nombre_completo as nombre_empleado,
                (SELECT COUNT(*) FROM ajuste_inventario_detalle WHERE id_ajuste = aim.id_ajuste) as total_detalles
            FROM ajuste_inventario_maestro aim
            LEFT JOIN empleado e ON aim.id_empleado = e.id_empleado
            ${whereString}
            ORDER BY aim.fecha_creacion DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

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

// ============================================
// GET /detalle/:id - Obtener detalle completo de un ajuste
// ============================================
router.get('/detalle/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;

    console.log('============================================');
    console.log('📥 GET /detalle/:id - Ajuste Inventario');
    console.log('ID:', id);
    console.log('============================================');

    try {
        // Obtener datos maestros
        const maestroQuery = `
            SELECT 
                aim.*,
                e.nombre_completo as nombre_empleado
            FROM ajuste_inventario_maestro aim
            LEFT JOIN empleado e ON aim.id_empleado = e.id_empleado
            WHERE aim.id_ajuste = $1
        `;
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
// POST / - Crear nuevo ajuste (YA EXISTENTE)
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
        const maestroResult = await client.query(
            `INSERT INTO ajuste_inventario_maestro (id_empleado, tipo_ajuste, motivo)
             VALUES ($1, $2, $3) RETURNING id_ajuste`,
            [id_empleado, tipo_ajuste, motivo]
        );
        const nuevoAjusteId = maestroResult.rows[0].id_ajuste;

        // 2. Procesar cada detalle
        for (const detalle of detalles) {
            
            // Insertar detalle
            await client.query(
                `INSERT INTO ajuste_inventario_detalle (id_ajuste, id_refaccion, id_insumo, id_lote_refaccion, cantidad, costo_ajuste)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [nuevoAjusteId, detalle.id_refaccion, detalle.id_insumo, detalle.id_lote, detalle.cantidad, detalle.costo_ajuste]
            );

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
                    await client.query(
                        `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final)
                         VALUES ($1, $2, $3)`,
                        [detalle.id_refaccion, detalle.cantidad, detalle.costo_ajuste]
                    );
                } else if (tipo_ajuste === 'SALIDA') {
                    await client.query(
                        'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote_refaccion = $2',
                        [Math.abs(detalle.cantidad), detalle.id_lote_refaccion]
                    );
                } else if (tipo_ajuste === 'REVALORIZACION') {
                    await client.query(
                        'UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final + $1 WHERE id_lote_refaccion = $2',
                        [detalle.costo_ajuste, detalle.id_lote_refaccion]
                    );
                }
            }
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

    console.log('============================================');
    console.log('📝 PUT /:id - Actualizando ajuste...');
    console.log('ID:', id);
    console.log('============================================');

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
                error: 'Ajuste no encontrado',
                message: `No se encontró un ajuste con el ID ${id}` 
            });
        }

        const ajusteOriginal = originalResult.rows[0];
        console.log('Ajuste original obtenido');

        // 2. REVERTIR el ajuste original
        console.log('⏪ Revirtiendo ajuste original...');
        for (const detalleOrig of ajusteOriginal.detalles_originales) {
            if (!detalleOrig.id_detalle) continue; // Skip null entries

            if (detalleOrig.id_insumo) {
                // Revertir insumo (restar la cantidad que se había sumado)
                await client.query(
                    'UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2',
                    [detalleOrig.cantidad, detalleOrig.id_insumo]
                );
                console.log(`Revertido insumo ID ${detalleOrig.id_insumo}: -${detalleOrig.cantidad}`);
            } else if (detalleOrig.id_refaccion) {
                if (ajusteOriginal.tipo_ajuste === 'ENTRADA') {
                    // Si fue entrada, eliminar el lote creado
                    // (Esto es complejo, por simplicidad solo ajustamos el stock)
                    await client.query(
                        'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_refaccion = $2 AND id_lote_refaccion = $3',
                        [detalleOrig.cantidad, detalleOrig.id_refaccion, detalleOrig.id_lote_refaccion]
                    );
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
                console.log(`Revertida refacción ID ${detalleOrig.id_refaccion}`);
            }
        }

        // 3. Actualizar maestro
        console.log('💾 Actualizando datos maestros...');
        await client.query(
            `UPDATE ajuste_inventario_maestro 
             SET id_empleado = $1, tipo_ajuste = $2, motivo = $3
             WHERE id_ajuste = $4`,
            [maestro.id_empleado, maestro.tipo_ajuste, maestro.motivo, id]
        );

        // 4. Eliminar detalles antiguos
        await client.query('DELETE FROM ajuste_inventario_detalle WHERE id_ajuste = $1', [id]);
        console.log('Detalles antiguos eliminados');

        // 5. Insertar nuevos detalles y aplicar nuevos ajustes
        console.log('⏩ Aplicando nuevos ajustes...');
        for (const detalle of detalles) {
            // Insertar detalle
            await client.query(
                `INSERT INTO ajuste_inventario_detalle (id_ajuste, id_refaccion, id_insumo, id_lote_refaccion, cantidad, costo_ajuste)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, detalle.id_refaccion, detalle.id_insumo, detalle.id_lote, detalle.cantidad, detalle.costo_ajuste]
            );

            // Aplicar lógica de negocio
            if (detalle.id_insumo) {
                await client.query(
                    'UPDATE insumo SET stock_actual = stock_actual + $1 WHERE id_insumo = $2',
                    [detalle.cantidad, detalle.id_insumo]
                );
                console.log(`Aplicado ajuste a insumo ID ${detalle.id_insumo}: +${detalle.cantidad}`);
            } else if (detalle.id_refaccion) {
                if (maestro.tipo_ajuste === 'ENTRADA') {
                    await client.query(
                        `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final)
                         VALUES ($1, $2, $3)`,
                        [detalle.id_refaccion, detalle.cantidad, detalle.costo_ajuste || 0]
                    );
                } else if (maestro.tipo_ajuste === 'SALIDA') {
                    await client.query(
                        'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote_refaccion = $2',
                        [Math.abs(detalle.cantidad), detalle.id_lote]
                    );
                } else if (maestro.tipo_ajuste === 'REVALORIZACION') {
                    await client.query(
                        'UPDATE lote_refaccion SET costo_unitario_final = costo_unitario_final + $1 WHERE id_lote_refaccion = $2',
                        [detalle.costo_ajuste, detalle.id_lote]
                    );
                }
                console.log(`Aplicado ajuste a refacción ID ${detalle.id_refaccion}`);
            }
        }

        await client.query('COMMIT');
        console.log('✅ Ajuste actualizado exitosamente');

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