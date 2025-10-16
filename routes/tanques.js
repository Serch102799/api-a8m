const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

// --- GET / (Obtener todos los tanques y totales por ubicación) ---
router.get('/', verifyToken, async (req, res) => {
    try {
        const tanquesPromise = pool.query(`
            SELECT t.*, u.nombre_ubicacion 
            FROM tanques_combustible t
            LEFT JOIN ubicaciones u ON t.id_ubicacion = u.id_ubicacion
            ORDER BY u.nombre_ubicacion, t.nombre_tanque
        `);
        const totalesPromise = pool.query(`
            SELECT u.nombre_ubicacion, SUM(t.nivel_actual_litros) as total_litros
            FROM tanques_combustible t
            JOIN ubicaciones u ON t.id_ubicacion = u.id_ubicacion
            GROUP BY u.nombre_ubicacion
        `);
        const [tanquesResult, totalesResult] = await Promise.all([tanquesPromise, totalesPromise]);
        res.json({
            tanques: tanquesResult.rows,
            totalesPorUbicacion: totalesResult.rows
        });
    } catch (error) {
        console.error('Error al obtener tanques:', error);
        res.status(500).json({ message: 'Error al obtener los tanques' });
    }
});

// --- GET /lista-simple (Para menús desplegables) ---
router.get('/lista-simple', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id_tanque, nombre_tanque FROM tanques_combustible ORDER BY nombre_tanque');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la lista de tanques' });
    }
});

// --- GET /:id/historial-recargas (Obtener historial de recargas de un tanque) ---
router.get('/:id/historial-recargas', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `SELECT id_recarga, litros_cargados, fecha_operacion, observaciones 
             FROM historial_recargas 
             WHERE id_tanque = $1 
             ORDER BY fecha_operacion DESC LIMIT 50`,
            [id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener historial de recargas:', error);
        res.status(500).json({ message: 'Error al obtener el historial de recargas' });
    }
});

// --- POST / (Crear un nuevo tanque) ---
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario', 'AdminDiesel'])], async (req, res) => {
    const { nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion } = req.body;
    if (!nombre_tanque || !id_ubicacion) {
        return res.status(400).json({ message: 'Nombre del tanque y ubicación son requeridos.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO tanques_combustible (nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion) VALUES ($1, $2, $3, $4) RETURNING *',
            [nombre_tanque, capacidad_litros || 0, nivel_actual_litros || 0, id_ubicacion]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear el tanque:', error);
        res.status(500).json({ message: 'Error al crear el tanque' });
    }
});

// --- PUT /:id (Actualizar un tanque) ---
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario', 'AdminDiesel'])], async (req, res) => {
    const { id } = req.params;
    const { nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion } = req.body;
    if (!nombre_tanque || !id_ubicacion) {
        return res.status(400).json({ message: 'Nombre del tanque y ubicación son requeridos.' });
    }
    try {
        const result = await pool.query(
            `UPDATE tanques_combustible 
             SET nombre_tanque = $1, capacidad_litros = $2, nivel_actual_litros = $3, id_ubicacion = $4
             WHERE id_tanque = $5 RETURNING *`,
            [nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Tanque no encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar el tanque:', error);
        res.status(500).json({ message: 'Error al actualizar el tanque' });
    }
});

// --- DELETE /:id (Eliminar un tanque) ---
router.delete('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario', 'AdminDiesel'])], async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM tanques_combustible WHERE id_tanque = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Tanque no encontrado.' });
        }
        res.json({ message: 'Tanque eliminado exitosamente.' });
    } catch (error) {
        console.error('Error al eliminar el tanque:', error);
        res.status(500).json({ message: 'Error al eliminar el tanque' });
    }
});

// --- POST /recargar/:id (Recargar un tanque y registrar en historial) ---
router.post('/recargar/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario', 'AdminDiesel'])], async (req, res) => {
    const { id } = req.params;
    const { litros_a_cargar, fecha_operacion, observaciones } = req.body;
    const id_empleado = req.user.id;

    if (!litros_a_cargar || isNaN(litros_a_cargar) || litros_a_cargar <= 0) {
        return res.status(400).json({ message: 'La cantidad de litros a cargar debe ser un número positivo.' });
    }

    if (!fecha_operacion) {
        return res.status(400).json({ message: 'La fecha de operación es requerida.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Actualizar nivel del tanque
        const updateResult = await client.query(
            `UPDATE tanques_combustible 
             SET nivel_actual_litros = nivel_actual_litros + $1 
             WHERE id_tanque = $2 
             RETURNING *`,
            [litros_a_cargar, id]
        );

        if (updateResult.rows.length === 0) {
            throw new Error('Tanque no encontrado.');
        }

        // 2. Registrar en historial
        await client.query(
            `INSERT INTO historial_recargas 
             (id_tanque, litros_cargados, fecha_operacion, id_empleado, observaciones)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, litros_a_cargar, fecha_operacion, id_empleado, observaciones || null]
        );

        await client.query('COMMIT');
        res.status(200).json(updateResult.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al recargar el tanque:', error);
        res.status(500).json({ message: error.message || 'Error al recargar el tanque' });
    } finally {
        client.release();
    }
});

module.exports = router;