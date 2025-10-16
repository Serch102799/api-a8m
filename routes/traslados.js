const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

/**
 * POST / - Registrar un traslado de combustible entre tanques
 */
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario', 'AdminDiesel'])], async (req, res) => {
    const { 
        id_tanque_origen, 
        id_tanque_destino, 
        litros_trasladados, 
        fecha_operacion,
        observaciones
    } = req.body;
    const id_empleado_responsable = req.user.id;

    // Validaciones
    if (!id_tanque_origen || !id_tanque_destino || !litros_trasladados || litros_trasladados <= 0 || !fecha_operacion) {
        return res.status(400).json({ message: 'Faltan datos requeridos (tanque origen, destino, litros y fecha).' });
    }
    if (id_tanque_origen === id_tanque_destino) {
        return res.status(400).json({ message: 'El tanque de origen y destino no pueden ser el mismo.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar si el tanque de origen existe y tiene suficiente combustible
        const tanqueOrigen = await client.query(
            'SELECT nivel_actual_litros FROM tanques_combustible WHERE id_tanque = $1 FOR UPDATE', 
            [id_tanque_origen]
        );
        if (tanqueOrigen.rows.length === 0) {
            throw new Error('El tanque de origen no existe.');
        }
        if (tanqueOrigen.rows[0].nivel_actual_litros < litros_trasladados) {
            throw new Error('El tanque de origen no tiene suficientes litros para el traslado.');
        }

        // 2. Verificar que el tanque destino existe
        const tanqueDestino = await client.query(
            'SELECT id_tanque FROM tanques_combustible WHERE id_tanque = $1 FOR UPDATE',
            [id_tanque_destino]
        );
        if (tanqueDestino.rows.length === 0) {
            throw new Error('El tanque de destino no existe.');
        }

        // 3. Restar del tanque de origen
        await client.query(
            'UPDATE tanques_combustible SET nivel_actual_litros = nivel_actual_litros - $1 WHERE id_tanque = $2',
            [litros_trasladados, id_tanque_origen]
        );

        // 4. Sumar al tanque de destino
        await client.query(
            'UPDATE tanques_combustible SET nivel_actual_litros = nivel_actual_litros + $1 WHERE id_tanque = $2',
            [litros_trasladados, id_tanque_destino]
        );

        // 5. Guardar el registro de traslado en historial
        await client.query(
            `INSERT INTO traslados_combustible 
             (id_tanque_origen, id_tanque_destino, litros_trasladados, id_empleado_responsable, fecha_operacion, observaciones)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id_tanque_origen, id_tanque_destino, litros_trasladados, id_empleado_responsable, fecha_operacion, observaciones || null]
        );

        await client.query('COMMIT');
        res.status(201).json({ message: 'Traslado de combustible registrado exitosamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de traslado:', error);
        res.status(500).json({ message: error.message || 'Error al procesar el traslado.' });
    } finally {
        client.release();
    }
});

/**
 * GET /historial - Obtener historial de traslados (últimos 100)
 */
router.get('/historial', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                tr.id_traslado,
                to_char(tr.fecha_operacion, 'YYYY-MM-DD HH24:MI') as fecha_operacion,
                to1.nombre_tanque as tanque_origen,
                to2.nombre_tanque as tanque_destino,
                tr.litros_trasladados,
                e.nombre_completo as empleado_responsable,
                tr.observaciones
            FROM traslados_combustible tr
            JOIN tanques_combustible to1 ON tr.id_tanque_origen = to1.id_tanque
            JOIN tanques_combustible to2 ON tr.id_tanque_destino = to2.id_tanque
            LEFT JOIN empleado e ON tr.id_empleado_responsable = e.id_empleado
            ORDER BY tr.fecha_operacion DESC
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener historial de traslados:', error);
        res.status(500).json({ message: 'Error al obtener el historial de traslados' });
    }
});

module.exports = router;