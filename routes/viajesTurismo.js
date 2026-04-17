const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const { registrarAuditoria } = require('../servicios/auditService');

// =======================================================
// 1. CREAR NUEVA RESERVA
// =======================================================
router.post('/reserva', [verifyToken, checkRole(['Admin', 'SuperUsuario', 'Secretaria'])], async (req, res) => {
    // 🛠️ Agregamos km_estimados
    const { folio_manual, fecha_salida, hora_salida, fecha_regreso, hora_regreso, nombre_cliente, telefono_cliente, lugar_salida, destino, costo_total, abono_inicial, observaciones, km_estimados } = req.body;
    const usuario_id = req.user.id;

    if (!nombre_cliente || !lugar_salida || !destino || !costo_total || !fecha_salida) {
        return res.status(400).json({ message: 'Faltan datos obligatorios para la reserva.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const viajeQuery = `
            INSERT INTO viajes_turismo (folio_manual, fecha_salida, hora_salida, fecha_regreso, hora_regreso, nombre_cliente, telefono_cliente, lugar_salida, destino, costo_total, observaciones, km_estimados, estatus) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'RESERVADO') RETURNING id_viaje
        `;
        const resViaje = await client.query(viajeQuery, [folio_manual, fecha_salida, hora_salida, fecha_regreso || null, hora_regreso || null, nombre_cliente, telefono_cliente, lugar_salida, destino, costo_total, observaciones, km_estimados || 0]);
        const idViajeNuevo = resViaje.rows[0].id_viaje;

        if (abono_inicial && abono_inicial > 0) {
            await client.query(`INSERT INTO pagos_viaje_turismo (id_viaje, monto, metodo_pago, recibio_id) VALUES ($1, $2, 'Efectivo', $3)`, [idViajeNuevo, abono_inicial, usuario_id]);
        }
        await client.query('COMMIT');
        res.status(201).json({ message: 'Reserva creada exitosamente', id_viaje: idViajeNuevo });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Error en el servidor al registrar la reserva.' });
    } finally { client.release(); }
});

// =======================================================
// 2. OBTENER TABLERO DE VIAJES
// =======================================================
router.get('/', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT v.id_viaje, v.folio_manual, v.fecha_salida, v.hora_salida, v.lugar_salida, v.nombre_cliente, v.destino, v.costo_total, v.estatus, v.km_estimados,
                a.economico as autobus, e.nombre as chofer,
                COALESCE((SELECT SUM(monto) FROM pagos_viaje_turismo WHERE id_viaje = v.id_viaje), 0) as total_abonado,
                -- Traemos los datos de la liquidación si ya existe
                l.rendimiento, l.litros_diesel, (l.km_final - l.km_inicial) as km_reales
            FROM viajes_turismo v
            LEFT JOIN autobus a ON v.id_autobus = a.id_autobus
            LEFT JOIN empleado e ON v.id_chofer = e.id_empleado
            LEFT JOIN liquidacion_viaje_turismo l ON v.id_viaje = l.id_viaje
            ORDER BY v.fecha_salida DESC
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al cargar el tablero de viajes.' });
    }
});

// =======================================================
// 3. DESPACHO LOGÍSTICO (Cambia a EN RUTA)
// =======================================================
router.put('/despacho/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { id_autobus, id_chofer } = req.body;

    // 1. Imprimimos en la consola de Node qué está recibiendo
    console.log(`[DESPACHO] Intentando despachar Viaje #${id} | Bus ID: ${id_autobus} | Chofer ID: ${id_chofer}`);

    // 2. Si llega vacío, rebotamos la petición con un 400 antes de crashear la BD
    if (!id_autobus || !id_chofer) {
        return res.status(400).json({ message: 'El ID del autobús o del chofer no se enviaron correctamente desde el sistema.' });
    }

    try {
        await pool.query(
            `UPDATE viajes_turismo SET id_autobus = $1, id_chofer = $2, estatus = 'EN RUTA' WHERE id_viaje = $3`, 
            [id_autobus, id_chofer, id]
        );
        res.json({ message: 'Viaje despachado correctamente.' });
    } catch (error) {
        console.error('💥 ERROR SQL AL DESPACHAR:', error.message);
        res.status(500).json({ message: 'Error en BD: ' + error.message });
    }
});

// =======================================================
// 4. LIQUIDACIÓN DE VIAJE (Cierra el Viaje)
// =======================================================
router.post('/liquidacion', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    // 🛠️ Recibimos los nuevos parámetros
    const { id_viaje, km_inicial, km_final, efectivo_entregado, gasto_casetas, gasto_sueldo_chofer, otros_gastos, observaciones_gastos, litros_diesel, rendimiento, motivo_desviacion_km } = req.body;
    const usuario_id = req.user.id;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        await client.query(`
            INSERT INTO liquidacion_viaje_turismo (id_viaje, km_inicial, km_final, efectivo_entregado, gasto_casetas, gasto_sueldo_chofer, otros_gastos, observaciones_gastos, litros_diesel, rendimiento, motivo_desviacion_km, liquido_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [id_viaje, km_inicial, km_final, efectivo_entregado || 0, gasto_casetas || 0, gasto_sueldo_chofer || 0, otros_gastos || 0, observaciones_gastos, litros_diesel || 0, rendimiento || 0, motivo_desviacion_km, usuario_id]);

        await client.query(`UPDATE viajes_turismo SET estatus = 'LIQUIDADO' WHERE id_viaje = $1`, [id_viaje]);
        
        await client.query('COMMIT');
        res.json({ message: 'Viaje liquidado exitosamente.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en liquidación:', error);
        res.status(500).json({ message: 'Error al liquidar el viaje.' });
    } finally { client.release(); }
});

// =======================================================
// 5. REVERTIR ESTATUS (SuperUsuario)
// =======================================================
router.put('/revertir/:id', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { estatus } = req.body;
    try {
        if(estatus === 'EN RUTA') {
            await pool.query(`DELETE FROM liquidacion_viaje_turismo WHERE id_viaje = $1`, [id]);
        }
        await pool.query(`UPDATE viajes_turismo SET estatus = $1 WHERE id_viaje = $2`, [estatus, id]);
        res.json({ message: `Estatus revertido a ${estatus}.` });
    } catch (error) {
        res.status(500).json({ message: 'Error al revertir el estatus.' });
    }
});

module.exports = router;