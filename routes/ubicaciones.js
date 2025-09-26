const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

/**
 * @swagger
 * tags:
 * - name: Ubicaciones
 * description: Gestión del catálogo de ubicaciones (corralones)
 */

// GET /api/ubicaciones - Obtener todas las ubicaciones
router.get('/', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM ubicaciones ORDER BY nombre_ubicacion');
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener ubicaciones:', error);
        res.status(500).json({ message: 'Error al obtener las ubicaciones' });
    }
});


module.exports = router;