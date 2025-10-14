// En routes/produccion.js
const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista', 'SuperUsuario'])], async (req, res) => {
    const { id_refaccion_producida, cantidad_producida, fecha_operacion, observaciones } = req.body;
    const id_empleado_responsable = req.user.id;

    if (!id_refaccion_producida || !cantidad_producida || cantidad_producida <= 0) {
        return res.status(400).json({ message: 'Se requiere la refacción a producir y una cantidad válida.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener la "receta" de la refacción a producir
        const recetaResult = await client.query(
            'SELECT id_refaccion_hijo, cantidad_necesaria FROM refaccion_componentes WHERE id_refaccion_padre = $1',
            [id_refaccion_producida]
        );
        if (recetaResult.rows.length === 0) {
            throw new Error('Esta refacción no tiene una receta de componentes definida.');
        }
        const receta = recetaResult.rows;

        // 2. Verificar si hay stock suficiente para TODOS los componentes
        for (const componente of receta) {
            const cantidadRequerida = componente.cantidad_necesaria * cantidad_producida;
            const stockResult = await client.query(
                'SELECT SUM(cantidad_disponible) as stock FROM lote_refaccion WHERE id_refaccion = $1',
                [componente.id_refaccion_hijo]
            );
            const stockDisponible = parseFloat(stockResult.rows[0].stock) || 0;
            if (stockDisponible < cantidadRequerida) {
                throw new Error(`Stock insuficiente para el componente ID ${componente.id_refaccion_hijo}. Se necesitan ${cantidadRequerida}, pero solo hay ${stockDisponible}.`);
            }
        }

        let costoTotalComponentes = 0;

        // 3. Descontar el stock de CADA componente usando el método PEPS (Primeras Entradas, Primeras Salidas)
        for (const componente of receta) {
            let cantidadADescontar = componente.cantidad_necesaria * cantidad_producida;
            const lotesDisponibles = await client.query(
                'SELECT id_lote, cantidad_disponible, costo_unitario_final FROM lote_refaccion WHERE id_refaccion = $1 AND cantidad_disponible > 0 ORDER BY id_detalle_entrada ASC',
                [componente.id_refaccion_hijo]
            );
            
            for (const lote of lotesDisponibles.rows) {
                if (cantidadADescontar <= 0) break;
                const cantidadDelLote = Math.min(lote.cantidad_disponible, cantidadADescontar);
                
                await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2', [cantidadDelLote, lote.id_lote]);
                costoTotalComponentes += cantidadDelLote * parseFloat(lote.costo_unitario_final);
                cantidadADescontar -= cantidadDelLote;
            }
        }
        
        // 4. Calcular el costo del nuevo producto y crear su LOTE
        const costoUnitarioNuevoProducto = costoTotalComponentes / cantidad_producida;
        await client.query(
            `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario) 
             VALUES ($1, $2, $3, $3, 0)`, // Se asume que el costo de producción no lleva IVA directo
            [id_refaccion_producida, cantidad_producida, costoUnitarioNuevoProducto]
        );

        // 5. Registrar la orden de producción para auditoría
        await client.query(
            `INSERT INTO orden_produccion (id_refaccion_producida, cantidad_producida, id_empleado_responsable, fecha_operacion, observaciones) 
             VALUES ($1, $2, $3, $4, $5)`,
            [id_refaccion_producida, cantidad_producida, id_empleado_responsable, fecha_operacion, observaciones]
        );

        await client.query('COMMIT');
        res.status(201).json({ message: 'Orden de producción registrada exitosamente. El inventario ha sido actualizado.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error en transacción de orden de producción:", error);
        res.status(500).json({ message: error.message || 'Error al procesar la orden de producción.' });
    } finally {
        client.release();
    }
});

module.exports = router;