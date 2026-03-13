const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

// GET /api/productos-compuestos/:id - Obtener los componentes de una refacción
router.get('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        // Usamos LEFT JOIN para poder traer la información sea refacción o sea insumo
        const result = await pool.query(
            `SELECT 
                rc.id_componente, 
                rc.id_refaccion_hijo,
                rc.id_insumo_hijo,
                COALESCE(r.nombre, i.nombre) as nombre_componente, 
                rc.cantidad_necesaria
             FROM refaccion_componentes rc
             LEFT JOIN refaccion r ON rc.id_refaccion_hijo = r.id_refaccion
             LEFT JOIN insumo i ON rc.id_insumo_hijo = i.id_insumo
             WHERE rc.id_refaccion_padre = $1`,
            [id]
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener componentes:', error);
        res.status(500).json({ message: 'Error al obtener componentes' });
    }
});

// POST /api/productos-compuestos/:id - Definir los componentes de una refacción
router.post('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params; // id_refaccion_padre
    const { componentes } = req.body; // Un arreglo de { id_refaccion_hijo, id_insumo_hijo, cantidad_necesaria }

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
            // Validación de seguridad para que no lleguen ambos nulos
            if (!comp.id_refaccion_hijo && !comp.id_insumo_hijo) {
                throw new Error('Un componente debe tener un ID de refacción o un ID de insumo válido.');
            }

            await client.query(
                `INSERT INTO refaccion_componentes (id_refaccion_padre, id_refaccion_hijo, id_insumo_hijo, cantidad_necesaria) 
                 VALUES ($1, $2, $3, $4)`,
                [
                    id, 
                    comp.id_refaccion_hijo || null, // Si es undefined, lo fuerza a null
                    comp.id_insumo_hijo || null,    // Si es undefined, lo fuerza a null
                    comp.cantidad_necesaria
                ]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ message: 'La receta del producto compuesto ha sido guardada.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al guardar la receta:', error);
        
        // Si lanzamos un throw Error personalizado arriba, lo mostramos al usuario
        const mensajeError = error.message.includes('Un componente') ? error.message : 'Error al guardar la receta del producto.';
        res.status(500).json({ message: mensajeError });
    } finally {
        client.release();
    }
});

module.exports = router;