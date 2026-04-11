const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

const { registrarAuditoria } = require('../servicios/auditService');

router.get('/historico', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id_prestamo, 
                p.fecha_prestamo, 
                COALESCE(p.nombre_solicitante_manual, e.nombre, 'Desconocido') as solicitante,
                dp.id_detalle_prestamo,
                dp.tipo_item,
                dp.cantidad_prestada,
                dp.cantidad_devuelta,
                dp.fecha_devolucion,
                dp.estado_devolucion,
                (dp.cantidad_prestada - dp.cantidad_devuelta) as pendiente,
                CASE 
                    WHEN dp.tipo_item = 'insumo' THEN (SELECT nombre FROM insumo WHERE id_insumo = dp.id_item)
                    WHEN dp.tipo_item = 'refaccion' THEN (SELECT nombre FROM refaccion WHERE id_refaccion = dp.id_item)
                END as nombre_item,
                
                -- 💰 NUEVO: Costo unitario
                COALESCE(
                    CASE 
                        WHEN dp.tipo_item = 'insumo' THEN (SELECT costo_unitario_promedio FROM insumo WHERE id_insumo = dp.id_item)
                        WHEN dp.tipo_item = 'refaccion' THEN (SELECT costo_unitario_final FROM lote_refaccion WHERE id_refaccion = dp.id_item ORDER BY fecha_ingreso DESC LIMIT 1)
                    END, 0
                ) as costo_unitario,
                
                -- 💰 NUEVO: Valor monetario total (Responsabilidad Financiera)
                (dp.cantidad_prestada * COALESCE(
                    CASE 
                        WHEN dp.tipo_item = 'insumo' THEN (SELECT costo_unitario_promedio FROM insumo WHERE id_insumo = dp.id_item)
                        WHEN dp.tipo_item = 'refaccion' THEN (SELECT costo_unitario_final FROM lote_refaccion WHERE id_refaccion = dp.id_item ORDER BY fecha_ingreso DESC LIMIT 1)
                    END, 0
                )) as valor_total_prestado

            FROM prestamos p
            JOIN detalle_prestamo dp ON p.id_prestamo = dp.id_prestamo
            LEFT JOIN empleado e ON p.id_empleado_solicitante = e.id_empleado
            WHERE p.estado = 'CERRADO' OR dp.cantidad_devuelta >= dp.cantidad_prestada
            ORDER BY dp.fecha_devolucion DESC, p.fecha_prestamo DESC
            LIMIT 500
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Error en GET /historico:', error); 
        res.status(500).json({ message: 'Error al obtener préstamos históricos.' });
    }
});

// 2. REGISTRAR PRESTAMO
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista', 'SuperUsuario'])], async (req, res) => {
    const { nombre_solicitante_manual, items, observaciones } = req.body;
    const id_empleado_almacen = req.user.id;

    if (!nombre_solicitante_manual || !items || items.length === 0) {
        return res.status(400).json({ message: 'Faltan datos para generar el préstamo.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const resPrestamo = await client.query(
            `INSERT INTO prestamos (nombre_solicitante_manual, id_empleado_almacen, observaciones) 
             VALUES ($1, $2, $3) RETURNING id_prestamo`,
            [nombre_solicitante_manual, id_empleado_almacen, observaciones]
        );
        const idPrestamo = resPrestamo.rows[0].id_prestamo;

        for (const item of items) {
            if (item.tipo === 'insumo') {
                const checkStock = await client.query('SELECT stock_actual, nombre FROM insumo WHERE id_insumo = $1', [item.id]);
                if (checkStock.rows[0].stock_actual < item.cantidad) {
                    throw new Error(`Stock insuficiente para insumo: ${checkStock.rows[0].nombre}`);
                }
                await client.query('UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2', [item.cantidad, item.id]);
            } else if (item.tipo === 'refaccion') {
                const loteQuery = await client.query(
                    `SELECT id_lote, cantidad_disponible FROM lote_refaccion 
                     WHERE id_refaccion = $1 AND cantidad_disponible >= $2 
                     ORDER BY fecha_ingreso ASC LIMIT 1`, 
                    [item.id, item.cantidad]
                );
                
                if (loteQuery.rows.length === 0) {
                     const nombreRef = await client.query('SELECT nombre FROM refaccion WHERE id_refaccion = $1', [item.id]);
                     throw new Error(`No hay lote con suficiente stock para la refacción: ${nombreRef.rows[0]?.nombre}`);
                }
                
                await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2', [item.cantidad, loteQuery.rows[0].id_lote]);
            }

            await client.query(
                `INSERT INTO detalle_prestamo (id_prestamo, tipo_item, id_item, cantidad_prestada) 
                 VALUES ($1, $2, $3, $4)`,
                [idPrestamo, item.tipo, item.id, item.cantidad]
            );
        }

        await client.query('COMMIT');

        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'CREAR',
            recurso_afectado: 'prestamos',
            id_recurso_afectado: idPrestamo,
            detalles_cambio: {
                solicitante: nombre_solicitante_manual,
                observaciones: observaciones,
                items_prestados: items
            },
            ip_address: req.ip
        });

        res.status(201).json({ message: 'Préstamo registrado exitosamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ message: error.message || 'Error al registrar el préstamo.' });
    } finally {
        client.release();
    }
});

// 3. REGISTRAR DEVOLUCIÓN
router.put('/devolucion', [verifyToken, checkRole(['Admin', 'Almacenista', 'SuperUsuario'])], async (req, res) => {
    const { id_detalle_prestamo, cantidad_devuelta, estado_devolucion } = req.body;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const detalleRes = await client.query('SELECT * FROM detalle_prestamo WHERE id_detalle_prestamo = $1', [id_detalle_prestamo]);
        if (detalleRes.rows.length === 0) throw new Error('Detalle de préstamo no encontrado.');
        
        const detalle = detalleRes.rows[0];
        const pendiente = parseFloat(detalle.cantidad_prestada) - parseFloat(detalle.cantidad_devuelta);

        if (cantidad_devuelta > pendiente) {
            throw new Error(`No puedes devolver más de lo pendiente (${pendiente}).`);
        }

        await client.query(
            `UPDATE detalle_prestamo 
             SET cantidad_devuelta = cantidad_devuelta + $1, 
                 fecha_devolucion = NOW(),
                 estado_devolucion = $2
             WHERE id_detalle_prestamo = $3`,
            [cantidad_devuelta, estado_devolucion, id_detalle_prestamo]
        );

        if (estado_devolucion === 'BUENO' && cantidad_devuelta > 0) {
            if (detalle.tipo_item === 'insumo') {
                await client.query('UPDATE insumo SET stock_actual = stock_actual + $1 WHERE id_insumo = $2', [cantidad_devuelta, detalle.id_item]);
            } else if (detalle.tipo_item === 'refaccion') {
                const loteReciente = await client.query(
                    'SELECT id_lote FROM lote_refaccion WHERE id_refaccion = $1 ORDER BY fecha_ingreso DESC LIMIT 1',
                    [detalle.id_item]
                );
                if (loteReciente.rows.length > 0) {
                    await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible + $1 WHERE id_lote = $2', [cantidad_devuelta, loteReciente.rows[0].id_lote]);
                }
            }
        }

        const prestamoPadre = await client.query(
            `SELECT COUNT(*) as pendientes 
             FROM detalle_prestamo 
             WHERE id_prestamo = $1 AND cantidad_prestada > cantidad_devuelta`,
            [detalle.id_prestamo]
        );

        let prestamoCerrado = false;
        if (parseInt(prestamoPadre.rows[0].pendientes) === 0) {
            await client.query("UPDATE prestamos SET estado = 'CERRADO' WHERE id_prestamo = $1", [detalle.id_prestamo]);
            prestamoCerrado = true;
        }

        await client.query('COMMIT');

        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'detalle_prestamo',
            id_recurso_afectado: id_detalle_prestamo,
            detalles_cambio: {
                accion: 'DEVOLUCIÓN DE ÍTEM',
                id_prestamo_padre: detalle.id_prestamo,
                tipo_item: detalle.tipo_item,
                id_item: detalle.id_item,
                cantidad_devuelta: cantidad_devuelta,
                estado_devolucion: estado_devolucion,
                prestamo_finalizado: prestamoCerrado
            },
            ip_address: req.ip
        });

        res.json({ message: 'Devolución registrada correctamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ message: error.message || 'Error al registrar devolución.' });
    } finally {
        client.release();
    }
});

// 4. OBTENER PRÉSTAMOS ACTIVOS (Para el tablero)
router.get('/activos', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                p.id_prestamo, 
                p.fecha_prestamo, 
                COALESCE(p.nombre_solicitante_manual, e.nombre, 'Desconocido') as solicitante,
                dp.id_detalle_prestamo,
                dp.tipo_item,
                dp.cantidad_prestada,
                dp.cantidad_devuelta,
                (dp.cantidad_prestada - dp.cantidad_devuelta) as pendiente,
                CASE 
                    WHEN dp.tipo_item = 'insumo' THEN (SELECT nombre FROM insumo WHERE id_insumo = dp.id_item)
                    WHEN dp.tipo_item = 'refaccion' THEN (SELECT nombre FROM refaccion WHERE id_refaccion = dp.id_item)
                END as nombre_item,
                
                -- 💰 NUEVO: Costo unitario
                COALESCE(
                    CASE 
                        WHEN dp.tipo_item = 'insumo' THEN (SELECT costo_unitario_promedio FROM insumo WHERE id_insumo = dp.id_item)
                        WHEN dp.tipo_item = 'refaccion' THEN (SELECT costo_unitario_final FROM lote_refaccion WHERE id_refaccion = dp.id_item ORDER BY fecha_ingreso DESC LIMIT 1)
                    END, 0
                ) as costo_unitario,
                
                -- 💰 NUEVO: Valor monetario total pendiente
                ((dp.cantidad_prestada - dp.cantidad_devuelta) * COALESCE(
                    CASE 
                        WHEN dp.tipo_item = 'insumo' THEN (SELECT costo_unitario_promedio FROM insumo WHERE id_insumo = dp.id_item)
                        WHEN dp.tipo_item = 'refaccion' THEN (SELECT costo_unitario_final FROM lote_refaccion WHERE id_refaccion = dp.id_item ORDER BY fecha_ingreso DESC LIMIT 1)
                    END, 0
                )) as valor_total_prestado

            FROM prestamos p
            JOIN detalle_prestamo dp ON p.id_prestamo = dp.id_prestamo
            LEFT JOIN empleado e ON p.id_empleado_solicitante = e.id_empleado
            WHERE p.estado = 'ACTIVO' AND (dp.cantidad_prestada - dp.cantidad_devuelta) > 0
            ORDER BY p.fecha_prestamo DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Error en GET /activos:', error); 
        res.status(500).json({ message: 'Error al obtener préstamos activos.' });
    }
});

module.exports = router;