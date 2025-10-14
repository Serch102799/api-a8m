
const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

// GET /api/productos-compuestos/:id - Obtener los componentes de una refacción
router.get('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            `SELECT rc.id_componente, r.nombre as nombre_componente, rc.cantidad_necesaria
             FROM refaccion_componentes rc
             JOIN refaccion r ON rc.id_refaccion_hijo = r.id_refaccion
             WHERE rc.id_refaccion_padre = $1`,
            [id]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener componentes' });
    }
});

// POST /api/productos-compuestos/:id - Definir los componentes de una refacción
router.post('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params; // id_refaccion_padre
    const { componentes } = req.body; // Un arreglo de { id_refaccion_hijo, cantidad_necesaria }

    if (!componentes || !Array.isArray(componentes)) {
        return res.status(400).json({ message: 'Se requiere un arreglo de componentes.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Marcar la refacción como "compuesta"
        await client.query('UPDATE refaccion SET es_compuesto = true WHERE id_refaccion = $1', [id]);

        // Borrar los componentes antiguos para reemplazarlos con la nueva lista
        await client.query('DELETE FROM refaccion_componentes WHERE id_refaccion_padre = $1', [id]);

        // Insertar los nuevos componentes
        for (const comp of componentes) {
            await client.query(
                'INSERT INTO refaccion_componentes (id_refaccion_padre, id_refaccion_hijo, cantidad_necesaria) VALUES ($1, $2, $3)',
                [id, comp.id_refaccion_hijo, comp.cantidad_necesaria]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'La receta del producto compuesto ha sido guardada.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al guardar la receta:', error);
        res.status(500).json({ message: 'Error al guardar la receta del producto.' });
    } finally {
        client.release();
    }
});


module.exports = router;