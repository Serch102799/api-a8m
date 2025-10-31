const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

// ============================================
// GET / - Listar TODOS los conteos
// ============================================
router.get('/', verifyToken, async (req, res) => {
    const {
        page = 1,
        limit = 15,
        search = '',
        // estado = '', // <-- Esta variable ya no se usa porque la columna no existe
        fecha_desde = '',
        fecha_hasta = ''
    } = req.query;

    // Se extrae 'estado' de req.query solo para que no interfiera, pero no se usará
    const { estado } = req.query; 

    try {
        const params = [];
        let whereClauses = [];

        // Filtro de búsqueda
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(e.nombre ILIKE $${params.length} OR cim.observaciones ILIKE $${params.length})`);
        }

        // ---------- INICIO DE CORRECCIÓN ----------
        // EL FILTRO DE ESTADO SE HA ELIMINADO PORQUE LA COLUMNA 'estado' NO EXISTE
        /*
        if (estado) {
            params.push(estado);
            whereClauses.push(`cim.estado = $${params.length}`);
        }
        */
        // ---------- FIN DE CORRECCIÓN ----------


        // Filtro de fecha (usando fecha_conteo)
        if (fecha_desde) {
            params.push(fecha_desde);
            whereClauses.push(`cim.fecha_conteo >= $${params.length}::timestamp`);
        }
        if (fecha_hasta) {
            params.push(fecha_hasta + ' 23:59:59');
            whereClauses.push(`cim.fecha_conteo <= $${params.length}::timestamp`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // Contar total
        const totalQuery = `
            SELECT COUNT(*) as count
            FROM conteo_inventario_maestro cim
            LEFT JOIN empleado e ON cim.id_empleado = e.id_empleado
            ${whereString}
        `;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // Obtener datos paginados
        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT 
                cim.id_conteo,
                cim.fecha_conteo,
                -- cim.estado, <-- CORRECCIÓN: Columna eliminada
                cim.observaciones,
                e.nombre as nombre,
                (SELECT COUNT(*) FROM conteo_inventario_detalle_insumo WHERE id_conteo = cim.id_conteo) as total_detalles
            FROM conteo_inventario_maestro cim
            LEFT JOIN empleado e ON cim.id_empleado = e.id_empleado
            ${whereString}
            ORDER BY cim.fecha_conteo DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        
        // CORRECCIÓN: Como 'estado' no existe, asignamos 'N/A' (No Aplica)
        // Tu frontend espera este campo, así que debemos enviarlo.
        const dataConEstadoFake = dataResult.rows.map(row => ({
            ...row,
            estado: 'N/A' 
        }));

        res.json({
            total: totalItems,
            data: dataConEstadoFake // Enviamos los datos con el 'estado' falso
        });

    } catch (error) {
        console.error('Error al obtener conteos:', error);
        res.status(500).json({ 
            message: 'Error al obtener conteos',
            error: error.message 
        });
    }
});

// ============================================
// PUT /:id - Actualizar un conteo
// ============================================
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    
    const { id } = req.params; // id_conteo
    const { maestro, detalles } = req.body;

    // Validación básica de que los datos llegaron
    if (!maestro || !detalles || !maestro.id_empleado || !maestro.estado) {
        return res.status(400).json({ message: 'Faltan datos del maestro o detalles.' });
    }
    if (detalles.length === 0) {
        return res.status(400).json({ message: 'El conteo debe tener al menos un detalle.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Actualizar el registro maestro
        const updateMaestroQuery = `
            UPDATE conteo_inventario_maestro
            SET 
                id_empleado = $1, 
                observaciones = $2, 
                estado = $3
            WHERE 
                id_conteo = $4;
        `;
        await client.query(updateMaestroQuery, [
            maestro.id_empleado,
            maestro.observaciones,
            maestro.estado,
            id
        ]);

        // 2. Borrar TODOS los detalles antiguos de este conteo.
        await client.query(
            'DELETE FROM conteo_inventario_detalle_insumo WHERE id_conteo = $1',
            [id]
        );

        // 3. Re-insertar todos los detalles
        for (const detalle of detalles) {
            
            if (!detalle.id_insumo || detalle.cantidad_contada < 0 || detalle.costo_unitario_asignado < 0) {
                throw new Error('Datos de detalle inválidos. Revisa que todos los insumos estén seleccionados y las cantidades/costos no sean negativos.');
            }
            
            const insertDetalleQuery = `
                INSERT INTO conteo_inventario_detalle_insumo
                (id_conteo, id_insumo, cantidad_contada, costo_unitario_asignado)
                VALUES ($1, $2, $3, $4);
            `;
            
            await client.query(insertDetalleQuery, [
                id, // El id_conteo maestro
                detalle.id_insumo,
                detalle.cantidad_contada,
                detalle.costo_unitario_asignado
            ]);
        }

        // 4. Finalizar la transacción
        await client.query('COMMIT');

        res.json({
            message: 'Conteo actualizado exitosamente',
            id_conteo: id
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al actualizar conteo:', error);
        res.status(500).json({ 
            message: 'Error en el servidor al actualizar el conteo',
            error: error.message 
        });
    } finally {
        client.release();
    }
});

// ============================================
// POST /:id/aplicar - Aplicar el conteo al stock
// ============================================
router.post('/:id/aplicar', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    
    const { id } = req.params; // id_conteo
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verificar el estado del conteo maestro
        const maestroQuery = 'SELECT estado FROM conteo_inventario_maestro WHERE id_conteo = $1';
        const maestroResult = await client.query(maestroQuery, [id]);

        if (maestroResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Conteo no encontrado.' });
        }

        const estadoActual = maestroResult.rows[0].estado;

        if (estadoActual === 'APLICADO') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Este conteo ya fue aplicado anteriormente.' });
        }
        
        if (estadoActual !== 'COMPLETADO') {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Solo se pueden aplicar conteos en estado 'COMPLETADO'. Estado actual: ${estadoActual}` });
        }

        // 2. Obtener todos los detalles del conteo
        const detallesQuery = 'SELECT id_insumo, cantidad_contada, costo_unitario_asignado FROM conteo_inventario_detalle_insumo WHERE id_conteo = $1';
        const detallesResult = await client.query(detallesQuery, [id]);

        if (detallesResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Este conteo no tiene detalles para aplicar.' });
        }
        
        // 3. Recorrer los detalles y APLICAR al inventario (tabla 'insumo')
        for (const detalle of detallesResult.rows) {
            const updateInsumoQuery = `
                UPDATE insumo 
                SET 
                    stock_actual = $1, 
                    costo_unitario_promedio = $2 
                WHERE 
                    id_insumo = $3;
            `;
            await client.query(updateInsumoQuery, [
                detalle.cantidad_contada,
                detalle.costo_unitario_asignado,
                detalle.id_insumo
            ]);
        }

        // 4. Marcar el conteo como 'APLICADO'
        const updateMaestroQuery = `
            UPDATE conteo_inventario_maestro 
            SET estado = 'APLICADO' 
            WHERE id_conteo = $1;
        `;
        await client.query(updateMaestroQuery, [id]);

        // 5. Finalizar la transacción
        await client.query('COMMIT');

        res.json({
            message: `Conteo #${id} aplicado exitosamente. Se actualizaron ${detallesResult.rows.length} insumos.`
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al aplicar conteo:', error);
        res.status(500).json({ 
            message: 'Error en el servidor al aplicar el conteo',
            error: error.message 
        });
    } finally {
        client.release();
    }
});

module.exports = router;