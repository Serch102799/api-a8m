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

        // 1. Obtener la "receta" (Ahora trae refacciones E insumos, con sus nombres para los errores)
        const recetaResult = await client.query(
            `SELECT 
                rc.id_refaccion_hijo, 
                rc.id_insumo_hijo, 
                rc.cantidad_necesaria,
                COALESCE(r.nombre, i.nombre) as nombre_item
             FROM refaccion_componentes rc
             LEFT JOIN refaccion r ON rc.id_refaccion_hijo = r.id_refaccion
             LEFT JOIN insumo i ON rc.id_insumo_hijo = i.id_insumo
             WHERE rc.id_refaccion_padre = $1`,
            [id_refaccion_producida]
        );

        if (recetaResult.rows.length === 0) {
            throw new Error('Este producto no tiene una receta de componentes definida.');
        }
        const receta = recetaResult.rows;

        // 2. Verificar si hay stock suficiente para TODOS los componentes (Refacciones e Insumos)
        for (const componente of receta) {
            const cantidadRequerida = componente.cantidad_necesaria * cantidad_producida;

            if (componente.id_refaccion_hijo) {
                // Validación para Refacciones
                const stockResult = await client.query(
                    'SELECT SUM(cantidad_disponible) as stock FROM lote_refaccion WHERE id_refaccion = $1',
                    [componente.id_refaccion_hijo]
                );
                const stockDisponible = parseFloat(stockResult.rows[0].stock) || 0;
                if (stockDisponible < cantidadRequerida) {
                    throw new Error(`Stock insuficiente para la refacción: ${componente.nombre_item}. Se necesitan ${cantidadRequerida}, pero solo hay ${stockDisponible}.`);
                }
            } else if (componente.id_insumo_hijo) {
                // Validación para Insumos
                const stockResult = await client.query(
                    'SELECT stock_actual FROM insumo WHERE id_insumo = $1',
                    [componente.id_insumo_hijo]
                );
                const stockDisponible = parseFloat(stockResult.rows[0].stock_actual) || 0;
                if (stockDisponible < cantidadRequerida) {
                    throw new Error(`Stock insuficiente para el insumo: ${componente.nombre_item}. Se necesitan ${cantidadRequerida}, pero solo hay ${stockDisponible}.`);
                }
            }
        }

        let costoTotalComponentes = 0;

        // 3. Descontar el stock y sumar los costos
        for (const componente of receta) {
            let cantidadADescontar = componente.cantidad_necesaria * cantidad_producida;

            if (componente.id_refaccion_hijo) {
                // Descuento para REFACCIONES usando PEPS (FIFO)
                const lotesDisponibles = await client.query(
                    'SELECT id_lote, cantidad_disponible, costo_unitario_final FROM lote_refaccion WHERE id_refaccion = $1 AND cantidad_disponible > 0 ORDER BY id_detalle_entrada ASC, id_lote ASC',
                    [componente.id_refaccion_hijo]
                );
                
                for (const lote of lotesDisponibles.rows) {
                    if (cantidadADescontar <= 0) break;
                    const cantidadDelLote = Math.min(lote.cantidad_disponible, cantidadADescontar);
                    
                    await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2', [cantidadDelLote, lote.id_lote]);
                    costoTotalComponentes += cantidadDelLote * parseFloat(lote.costo_unitario_final);
                    cantidadADescontar -= cantidadDelLote;
                }
            } else if (componente.id_insumo_hijo) {
                // Descuento para INSUMOS (Directo a la tabla insumo)
                const insumoRes = await client.query(
                    'SELECT costo_unitario_promedio FROM insumo WHERE id_insumo = $1',
                    [componente.id_insumo_hijo]
                );
                const costoInsumo = parseFloat(insumoRes.rows[0].costo_unitario_promedio || 0);

                await client.query(
                    'UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2',
                    [cantidadADescontar, componente.id_insumo_hijo]
                );
                
                costoTotalComponentes += cantidadADescontar * costoInsumo;
            }
        }
        
        // 4. Calcular el costo del nuevo producto y crear su LOTE
        const costoUnitarioNuevoProducto = costoTotalComponentes / cantidad_producida;
        await client.query(
            `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario, fecha_ingreso) 
             VALUES ($1, $2, $3, $3, 0, CURRENT_DATE)`,
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