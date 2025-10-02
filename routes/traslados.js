// En routes/traslados.js
const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { 
        id_tanque_origen, 
        id_tanque_destino, 
        litros_trasladados, 
        fecha_operacion,
        observaciones
    } = req.body;
    const id_empleado_responsable = req.user.id;

    if (!id_tanque_origen || !id_tanque_destino || !litros_trasladados || litros_trasladados <= 0 || !fecha_operacion) {
        return res.status(400).json({ message: 'Faltan datos requeridos (tanque origen, destino, litros y fecha).' });
    }
    if (id_tanque_origen === id_tanque_destino) {
        return res.status(400).json({ message: 'El tanque de origen y destino no pueden ser el mismo.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Verificar si el tanque de origen tiene suficiente combustible
        const tanqueOrigen = await client.query(
            'SELECT nivel_actual_litros FROM tanques_combustible WHERE id_tanque = $1 FOR UPDATE', 
            [id_tanque_origen]
        );
        if (tanqueOrigen.rows.length === 0) throw new Error('El tanque de origen no existe.');
        if (tanqueOrigen.rows[0].nivel_actual_litros < litros_trasladados) {
            throw new Error('El tanque de origen no tiene suficientes litros para el traslado.');
        }

        // 2. Restar del tanque de origen
        await client.query(
            'UPDATE tanques_combustible SET nivel_actual_litros = nivel_actual_litros - $1 WHERE id_tanque = $2',
            [litros_trasladados, id_tanque_origen]
        );

        // 3. Sumar al tanque de destino
        await client.query(
            'UPDATE tanques_combustible SET nivel_actual_litros = nivel_actual_litros + $1 WHERE id_tanque = $2',
            [litros_trasladados, id_tanque_destino]
        );

        // 4. Guardar el registro de auditoría en la nueva tabla
        await client.query(
            `INSERT INTO traslados_combustible 
             (id_tanque_origen, id_tanque_destino, litros_trasladados, id_empleado_responsable, fecha_operacion, observaciones)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [id_tanque_origen, id_tanque_destino, litros_trasladados, id_empleado_responsable, fecha_operacion, observaciones]
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

module.exports = router;