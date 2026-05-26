const express = require('express');
const router = express.Router();
const pool = require('../db'); 
const verifyToken = require('../middleware/verifyToken'); 
const { registrarAuditoria } = require('../servicios/auditService');

router.use(verifyToken);

// =======================================================
// 1. OBTENER TODO EL HISTORIAL DE GRANEL (Para la Consola/Panel)
// =======================================================
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                cg.*, 
                i.nombre as nombre_insumo, 
                i.unidad_medida,
                COALESCE((SELECT COUNT(*) FROM uso_consumible_granel ucg WHERE ucg.id_consumible_granel = cg.id_consumible_granel), 0) as usos_registrados
            FROM consumible_granel cg
            JOIN insumo i ON cg.id_insumo = i.id_insumo
            ORDER BY cg.estado ASC, cg.fecha_apertura DESC
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (error) {
        console.error('Error al obtener panel de granel:', error);
        res.status(500).json({ message: 'Error interno del servidor' });
    }
});

// =======================================================
// 2. OBTENER SOLO CONSUMIBLES ABIERTOS (Para Checkboxes en Salidas)
// =======================================================
router.get('/activos', async (req, res) => {
    try {
        const query = `
            SELECT cg.id_consumible_granel, i.nombre as nombre_insumo, cg.fecha_apertura
            FROM consumible_granel cg
            JOIN insumo i ON cg.id_insumo = i.id_insumo
            WHERE cg.estado = 'Abierto'
            ORDER BY cg.fecha_apertura DESC
        `;
        const { rows } = await pool.query(query);
        res.json(rows);
    } catch (error) {
        console.error('Error al obtener granel activo:', error);
        res.status(500).json({ message: 'Error interno' });
    }
});

// =======================================================
// 3. ABRIR UN TAMBOR NUEVO EN PISO
// =======================================================
router.post('/abrir', async (req, res) => {
    const { id_insumo } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // A. Verificamos stock y costo del insumo
        const insumoReq = await client.query('SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id_insumo]);
        const insumo = insumoReq.rows[0];

        if (insumo.stock_actual < 1) throw new Error('No hay stock suficiente en almacén para abrir este insumo.');

        // B. Descontamos 1 unidad del Almacén General
        await client.query('UPDATE insumo SET stock_actual = stock_actual - 1 WHERE id_insumo = $1', [id_insumo]);

        // C. Creamos el registro del Tambor Abierto
        const insertGranel = await client.query(`
            INSERT INTO consumible_granel (id_insumo, costo_total_tambor, id_empleado_abrio) 
            VALUES ($1, $2, $3) RETURNING *
        `, [id_insumo, insumo.costo_unitario_promedio, req.user.id]);

        await client.query('COMMIT');
        
        // 🛡️ AUDITORÍA
        registrarAuditoria({
            id_empleado: req.user.id,
            tipo_accion: 'CREAR',
            recurso_afectado: 'consumible_granel',
            id_recurso_afectado: insertGranel.rows[0].id_consumible_granel,
            detalles_cambio: { mensaje: 'Se abrió un insumo a granel para piso de taller', costo: insumo.costo_unitario_promedio },
            ip_address: req.ip
        });

        res.json({ message: 'Tambor abierto y movido a piso correctamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
});

// =======================================================
// 4. CERRAR TAMBOR Y PRORRATEAR COSTOS
// =======================================================
router.post('/:id/cerrar-prorratear', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // A. Obtenemos datos del tambor
        const tamborReq = await client.query('SELECT * FROM consumible_granel WHERE id_consumible_granel = $1', [id]);
        if (tamborReq.rows.length === 0) throw new Error('Tambor no encontrado');
        const tambor = tamborReq.rows[0];

        if (tambor.estado === 'Cerrado') throw new Error('Este tambor ya fue liquidado anteriormente.');

        // B. Contamos cuántos vehículos lo usaron
        const usosReq = await client.query('SELECT COUNT(*) as total_usos FROM uso_consumible_granel WHERE id_consumible_granel = $1', [id]);
        const totalUsos = parseInt(usosReq.rows[0].total_usos);

        let costoPorVehiculo = 0;

        // C. Si hubo usos, hacemos la división matemática
        if (totalUsos > 0) {
            costoPorVehiculo = parseFloat(tambor.costo_total_tambor) / totalUsos;

            // Actualizamos los registros fantasmas inyectándoles el costo real
            await client.query(`
                UPDATE uso_consumible_granel 
                SET costo_prorrateado = $1 
                WHERE id_consumible_granel = $2
            `, [costoPorVehiculo, id]);
        }

        // D. Cerramos el tambor
        await client.query(`
            UPDATE consumible_granel 
            SET estado = 'Cerrado', fecha_cierre = CURRENT_TIMESTAMP 
            WHERE id_consumible_granel = $1
        `, [id]);

        await client.query('COMMIT');

        // 🛡️ AUDITORÍA
        registrarAuditoria({
            id_empleado: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'consumible_granel',
            id_recurso_afectado: id,
            detalles_cambio: { 
                mensaje: 'Se liquidó insumo a granel.', 
                vehiculos_impactados: totalUsos, 
                costo_por_vehiculo: costoPorVehiculo 
            },
            ip_address: req.ip
        });

        res.json({ 
            message: 'Tambor cerrado con éxito.', 
            vehiculos_impactados: totalUsos, 
            costo_asignado_por_vehiculo: costoPorVehiculo 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;