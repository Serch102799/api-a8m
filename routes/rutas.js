const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');


router.get('/lista-simple', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT id_ruta, nombre_ruta FROM rutas ORDER BY nombre_ruta');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener la lista de rutas' });
    }
});
// GET /api/rutas - Obtener todas las rutas (con paginación y búsqueda simple)
router.get('/', verifyToken, async (req, res) => {
    const { page = 1, limit = 10, search = '' } = req.query;
    try {
        const params = [];
        let whereClause = '';
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClause = `WHERE nombre_ruta ILIKE $${params.length}`;
        }
        
        const totalResult = await pool.query(`SELECT COUNT(*) FROM rutas ${whereClause}`, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const offset = (page - 1) * limit;
        const dataResult = await pool.query(
            `SELECT * FROM rutas ${whereClause} ORDER BY nombre_ruta ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        
        res.json({ total: totalItems, data: dataResult.rows });
    } catch (error) {
        console.error('Error al obtener rutas:', error);
        res.status(500).json({ message: 'Error al obtener las rutas' });
    }
});

// POST /api/rutas - Crear una nueva ruta
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { nombre_ruta, descripcion, kilometraje_vuelta } = req.body;
    if (!nombre_ruta || !kilometraje_vuelta) {
        return res.status(400).json({ message: 'Nombre de la ruta y kilometraje son requeridos.' });
    }
    try {
        const result = await pool.query(
            'INSERT INTO rutas (nombre_ruta, descripcion, kilometraje_vuelta) VALUES ($1, $2, $3) RETURNING *',
            [nombre_ruta, descripcion, kilometraje_vuelta]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error al crear la ruta:', error);
        res.status(500).json({ message: 'Error al crear la ruta' });
    }
});

// PUT /api/rutas/:id - Actualizar una ruta
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { nombre_ruta, descripcion, kilometraje_vuelta } = req.body;
    if (!nombre_ruta || !kilometraje_vuelta) {
        return res.status(400).json({ message: 'Nombre de la ruta y kilometraje son requeridos.' });
    }
    try {
        const result = await pool.query(
            'UPDATE rutas SET nombre_ruta = $1, descripcion = $2, kilometraje_vuelta = $3 WHERE id_ruta = $4 RETURNING *',
            [nombre_ruta, descripcion, kilometraje_vuelta, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Ruta no encontrada.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al actualizar la ruta:', error);
        res.status(500).json({ message: 'Error al actualizar la ruta' });
    }
});

// DELETE /api/rutas/:id - Eliminar una ruta
router.delete('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM rutas WHERE id_ruta = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Ruta no encontrada.' });
        }
        res.json({ message: 'Ruta eliminada exitosamente.' });
    } catch (error) {
        console.error('Error al eliminar la ruta:', error);
        res.status(500).json({ message: 'Error al eliminar la ruta' });
    }
});


module.exports = router;