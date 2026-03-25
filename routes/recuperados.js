const express = require('express');
const router = express.dirname ? express.Router() : express.Router();
const pool = require('../db'); // Ajusta la ruta a tu archivo de conexión a la BD
const verifyToken = require('../middleware/verifyToken'); // Ajusta la ruta a tu middleware

// =======================================================
// OBTENER TODAS LAS PIEZAS RECUPERADAS (Para el Tablero Kanban)
// =======================================================
router.get('/', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                pr.*, 
                r.nombre AS nombre_pieza, 
                r.numero_parte,
                a_origen.economico AS origen_economico,
                a_destino.economico AS destino_economico,
                p.nombre_proveedor AS nombre_proveedor
            FROM pieza_recuperada pr
            LEFT JOIN refaccion r ON pr.id_refaccion = r.id_refaccion
            LEFT JOIN autobus a_origen ON pr.id_autobus_origen = a_origen.id_autobus
            LEFT JOIN autobus a_destino ON pr.id_autobus_destino = a_destino.id_autobus
            LEFT JOIN proveedor p ON pr.id_proveedor_reparacion = p.id_proveedor
            ORDER BY pr.fecha_baja DESC;
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al obtener piezas recuperadas:', error);
        res.status(500).json({ message: 'Error al obtener los datos.', error: error.message });
    }
});

// =======================================================
// REGISTRAR NUEVA PIEZA AL YONQUE (Ingreso inicial)
// =======================================================
router.post('/', verifyToken, async (req, res) => {
    const { id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones } = req.body;

    try {
        const query = `
            INSERT INTO pieza_recuperada 
            (id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones, estado, fecha_baja) 
            VALUES ($1, $2, $3, $4, $5, 'Yonque', CURRENT_TIMESTAMP) 
            RETURNING *;
        `;
        const values = [id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones];
        const { rows } = await pool.query(query, values);
        res.status(201).json({ message: 'Pieza ingresada al Yonque con éxito.', data: rows[0] });
    } catch (error) {
        console.error('Error al registrar pieza:', error);
        res.status(500).json({ message: 'Error al registrar la pieza.', error: error.message });
    }
});

// =======================================================
// ACTUALIZAR ESTADO Y DATOS DE LA PIEZA (Mover en el Kanban)
// =======================================================
router.put('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const { 
        estado, id_proveedor_reparacion, costo_reparacion, 
        factura_reparacion, id_autobus_destino, observaciones 
    } = req.body;

    try {
        // Dependiendo del estado al que pase, actualizamos ciertas fechas automáticamente
        let query = `
            UPDATE pieza_recuperada 
            SET estado = $1, 
                id_proveedor_reparacion = COALESCE($2, id_proveedor_reparacion),
                costo_reparacion = COALESCE($3, costo_reparacion),
                factura_reparacion = COALESCE($4, factura_reparacion),
                id_autobus_destino = COALESCE($5, id_autobus_destino),
                observaciones = COALESCE($6, observaciones)
        `;
        
        // Agregar marcas de tiempo según el estado
        if (estado === 'En Reparación') query += `, fecha_envio = CURRENT_TIMESTAMP`;
        if (estado === 'Disponible') query += `, fecha_retorno = CURRENT_TIMESTAMP`;
        if (estado === 'Instalada') query += `, fecha_instalacion = CURRENT_TIMESTAMP`;

        query += ` WHERE id_pieza_recuperada = $7 RETURNING *;`;

        const values = [estado, id_proveedor_reparacion, costo_reparacion, factura_reparacion, id_autobus_destino, observaciones, id];
        
        const { rows } = await pool.query(query, values);
        
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Pieza no encontrada.' });
        }
        res.status(200).json({ message: `Pieza movida a ${estado} correctamente.`, data: rows[0] });
    } catch (error) {
        console.error('Error al actualizar pieza:', error);
        res.status(500).json({ message: 'Error al actualizar la pieza.', error: error.message });
    }
});

// =======================================================
// ELIMINAR PIEZA (Si se registró por error)
// =======================================================
router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM pieza_recuperada WHERE id_pieza_recuperada = $1 RETURNING *;';
        const { rows } = await pool.query(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Pieza no encontrada.' });
        }
        res.status(200).json({ message: 'Registro de pieza eliminado correctamente.' });
    } catch (error) {
        console.error('Error al eliminar pieza:', error);
        res.status(500).json({ message: 'Error al eliminar la pieza.', error: error.message });
    }
});

module.exports = router;