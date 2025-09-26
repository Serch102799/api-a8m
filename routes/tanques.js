const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

/**
 * @swagger
 * tags:
 * - name: Tanques
 * description: Gestión del catálogo de tanques de combustible
 */

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

// --- POST / (Crear un nuevo tanque) ---
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion } = req.body;
    if (!nombre_tanque || !id_ubicacion) {
        return res.status(400).json({ message: 'Nombre del tanque y ubicación son requeridos.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO tanques_combustible (nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion) VALUES ($1, $2, $3, $4) RETURNING *',
            [nombre_tanque, capacidad_litros, nivel_actual_litros, id_ubicacion]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Error al crear el tanque' });
    }
});

// --- PUT /:id (Actualizar un tanque) ---
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
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
router.delete('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
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
router.post('/recargar/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { litros_a_cargar } = req.body;
    const id_empleado = req.user.id; // Para un futuro log de auditoría

    if (!litros_a_cargar || isNaN(litros_a_cargar) || litros_a_cargar <= 0) {
        return res.status(400).json({ message: 'La cantidad de litros a cargar debe ser un número positivo.' });
    }

    try {
        const result = await pool.query(
            `UPDATE tanques_combustible 
             SET nivel_actual_litros = nivel_actual_litros + $1 
             WHERE id_tanque = $2 
             RETURNING *`,
            [litros_a_cargar, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Tanque no encontrado.' });
        }
        
        // Opcional: Aquí podrías insertar un registro en una tabla de 'log_recargas' para auditoría.

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error al recargar el tanque:', error);
        res.status(500).json({ message: 'Error al recargar el tanque' });
    }
});


module.exports = router;