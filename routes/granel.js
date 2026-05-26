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
                COALESCE(i.nombre, r.nombre) as nombre_insumo, 
                COALESCE(i.unidad_medida, 'Pieza') as unidad_medida,
                COALESCE((SELECT COUNT(*) FROM uso_consumible_granel ucg WHERE ucg.id_consumible_granel = cg.id_consumible_granel), 0) as usos_registrados
            FROM consumible_granel cg
            LEFT JOIN insumo i ON cg.id_insumo = i.id_insumo
            LEFT JOIN refaccion r ON cg.id_refaccion = r.id_refaccion
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
            SELECT 
                cg.id_consumible_granel, 
                COALESCE(i.nombre, r.nombre) as nombre_insumo, 
                cg.fecha_apertura
            FROM consumible_granel cg
            LEFT JOIN insumo i ON cg.id_insumo = i.id_insumo
            LEFT JOIN refaccion r ON cg.id_refaccion = r.id_refaccion
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
// 3. ABRIR UN NUEVO ARTÍCULO EN PISO (Soporta Insumo o Refacción)
// =======================================================
router.post('/abrir', async (req, res) => {
    const { id_item, tipo_item } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        let costoTotal = 0;
        let idInsumo = null;
        let idRefaccion = null;

        if (tipo_item === 'insumo') {
            const insumoReq = await client.query('SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id_item]);
            if (insumoReq.rows[0].stock_actual < 1) throw new Error('No hay stock suficiente.');
            
            await client.query('UPDATE insumo SET stock_actual = stock_actual - 1 WHERE id_insumo = $1', [id_item]);
            costoTotal = insumoReq.rows[0].costo_unitario_promedio;
            idInsumo = id_item;
        } 
        else if (tipo_item === 'refaccion') {
            // Buscamos el lote más antiguo con stock (Sistema FIFO)
            const loteReq = await client.query(`
                SELECT id_lote, cantidad_disponible, costo_unitario_final 
                FROM lote_refaccion WHERE id_refaccion = $1 AND cantidad_disponible > 0 
                ORDER BY fecha_ingreso ASC LIMIT 1 FOR UPDATE
            `, [id_item]);

            if (loteReq.rows.length === 0) throw new Error('No hay lotes con stock para esta refacción.');
            
            await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - 1 WHERE id_lote = $1', [loteReq.rows[0].id_lote]);
            costoTotal = loteReq.rows[0].costo_unitario_final;
            idRefaccion = id_item;
        }

        const insertGranel = await client.query(`
            INSERT INTO consumible_granel (id_insumo, id_refaccion, costo_total_tambor, id_empleado_abrio) 
            VALUES ($1, $2, $3, $4) RETURNING *
        `, [idInsumo, idRefaccion, costoTotal, req.user.id]);

        await client.query('COMMIT');
        
        registrarAuditoria({
            id_empleado: req.user.id,
            tipo_accion: 'CREAR',
            recurso_afectado: 'consumible_granel',
            id_recurso_afectado: insertGranel.rows[0].id_consumible_granel,
            detalles_cambio: { mensaje: `Se abrió ${tipo_item} en piso de taller`, costo: costoTotal },
            ip_address: req.ip
        });

        res.json({ message: 'Artículo movido a piso correctamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
});

// =======================================================
// 4. PRORRATEO TRADICIONAL (A los que lo marcaron)
// =======================================================
router.post('/:id/cerrar-prorratear', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const tamborReq = await client.query('SELECT * FROM consumible_granel WHERE id_consumible_granel = $1 FOR UPDATE', [id]);
        if (tamborReq.rows[0].estado === 'Cerrado') throw new Error('Ya fue liquidado.');
        
        const tambor = tamborReq.rows[0];
        const usosReq = await client.query('SELECT COUNT(*) as total_usos FROM uso_consumible_granel WHERE id_consumible_granel = $1', [id]);
        const totalUsos = parseInt(usosReq.rows[0].total_usos);

        let costoPorVehiculo = 0;
        if (totalUsos > 0) {
            costoPorVehiculo = parseFloat(tambor.costo_total_tambor) / totalUsos;
            await client.query('UPDATE uso_consumible_granel SET costo_prorrateado = $1 WHERE id_consumible_granel = $2', [costoPorVehiculo, id]);
        }

        await client.query(`UPDATE consumible_granel SET estado = 'Cerrado', fecha_cierre = CURRENT_TIMESTAMP WHERE id_consumible_granel = $1`, [id]);
        await client.query('COMMIT');
        res.json({ message: 'Liquidado con éxito.', vehiculos_impactados: totalUsos, costo_asignado_por_vehiculo: costoPorVehiculo });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
});

// =======================================================
// 5. NUEVO: PRORRATEO GLOBAL (A toda la flota de autobuses)
// =======================================================
router.post('/:id/prorrateo-global', async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        
        // Obtenemos el artículo
        const tamborReq = await client.query('SELECT * FROM consumible_granel WHERE id_consumible_granel = $1 FOR UPDATE', [id]);
        if (tamborReq.rows[0].estado === 'Cerrado') throw new Error('Ya fue liquidado.');
        const tambor = tamborReq.rows[0];

        // Obtenemos todos los autobuses (excluimos particulares)
        const busesReq = await client.query("SELECT id_autobus FROM autobus");
        const totalBuses = busesReq.rows.length;

        if (totalBuses === 0) throw new Error('No hay autobuses registrados para hacer la división.');

        const costoPorBus = parseFloat(tambor.costo_total_tambor) / totalBuses;

        // Limpiamos los usos fantasma que hubieran marcado los mecánicos, porque ahora será global
        await client.query('DELETE FROM uso_consumible_granel WHERE id_consumible_granel = $1', [id]);

        // Insertamos un registro de uso para CADA AUTOBÚS
        for (let bus of busesReq.rows) {
            await client.query(`
                INSERT INTO uso_consumible_granel (id_consumible_granel, id_autobus, costo_prorrateado, fecha_uso) 
                VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
            `, [id, bus.id_autobus, costoPorBus]);
        }

        // Cerramos el artículo
        await client.query(`UPDATE consumible_granel SET estado = 'Cerrado', fecha_cierre = CURRENT_TIMESTAMP WHERE id_consumible_granel = $1`, [id]);
        
        await client.query('COMMIT');
        
        registrarAuditoria({
            id_empleado: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'consumible_granel_global',
            id_recurso_afectado: id,
            detalles_cambio: { mensaje: 'Prorrateo Global a Flota', vehiculos_impactados: totalBuses, costo: costoPorBus },
            ip_address: req.ip
        });

        res.json({ message: 'Gasto dividido entre toda la flota.', vehiculos_impactados: totalBuses, costo_asignado_por_vehiculo: costoPorBus });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(400).json({ message: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;