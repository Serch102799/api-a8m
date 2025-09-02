// En routes/inventarioInicial.js
const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

/**
 * @swagger
 * tags:
 *   - name: Inventario Inicial
 *     description: Gestión de carga inicial del inventario
 */

/**
 * @swagger
 * /api/inventario-inicial:
 *   post:
 *     summary: Registrar el inventario inicial
 *     description: 
 *       Crea un nuevo conteo maestro de inventario y carga los detalles asociados, 
 *       generando automáticamente los lotes iniciales de refacciones en el inventario.
 *     tags: [Inventario Inicial]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - maestro
 *               - detalles
 *             properties:
 *               maestro:
 *                 type: object
 *                 required:
 *                   - id_empleado
 *                   - fecha_conteo
 *                 properties:
 *                   id_empleado:
 *                     type: integer
 *                     description: ID del empleado que realiza el conteo
 *                     example: 3
 *                   fecha_conteo:
 *                     type: string
 *                     format: date
 *                     description: Fecha en que se realizó el conteo
 *                     example: "2025-08-31"
 *                   observaciones:
 *                     type: string
 *                     description: Observaciones adicionales del conteo
 *                     example: "Carga inicial de inventario en bodega principal"
 *               detalles:
 *                 type: array
 *                 description: Lista de refacciones con sus cantidades y costos
 *                 items:
 *                   type: object
 *                   required:
 *                     - id_refaccion
 *                     - cantidad
 *                     - costo
 *                   properties:
 *                     id_refaccion:
 *                       type: integer
 *                       description: ID de la refacción
 *                       example: 12
 *                     cantidad:
 *                       type: integer
 *                       description: Cantidad contada de la refacción
 *                       example: 50
 *                     costo:
 *                       type: number
 *                       format: float
 *                       description: Costo unitario asignado a la refacción
 *                       example: 125.75
 *     responses:
 *       201:
 *         description: Inventario inicial cargado exitosamente.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id_conteo:
 *                   type: integer
 *                   description: ID del conteo maestro generado
 *                   example: 101
 *                 message:
 *                   type: string
 *                   example: "Inventario inicial cargado exitosamente."
 *       400:
 *         description: Faltan datos del maestro o detalles.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Faltan datos del maestro o detalles para el conteo."
 *       401:
 *         description: Token no proporcionado o inválido.
 *       403:
 *         description: Acceso denegado. Se requiere rol Admin o SuperUsuario.
 *       500:
 *         description: Error en el servidor al procesar la carga de inventario.
 */
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    // CAMBIO: Se aceptan dos arreglos de detalles
    const { maestro, detallesRefacciones, detallesInsumos } = req.body;
    const { id_empleado, fecha_conteo, motivo } = maestro;

    if (!id_empleado || !fecha_conteo || !motivo) {
        return res.status(400).json({ message: 'Faltan datos del maestro del ajuste (empleado, fecha, motivo).' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Crear el registro maestro (sin cambios)
        const conteoResult = await client.query(
            `INSERT INTO conteo_inventario_maestro (id_empleado, fecha_conteo, observaciones)
             VALUES ($1, $2, $3) RETURNING id_conteo`,
            [id_empleado, fecha_conteo, motivo] // 'motivo' viene de 'observaciones' en el plan original
        );
        const nuevoConteoId = conteoResult.rows[0].id_conteo;

        // 2. Procesar los detalles de las REFACCIONES (crea lotes)
        if (detallesRefacciones && detallesRefacciones.length > 0) {
            for (const detalle of detallesRefacciones) {
                // Guarda el registro de auditoría
                await client.query(
                    `INSERT INTO conteo_inventario_detalle (id_conteo, id_refaccion, cantidad_contada, costo_unitario_asignado)
                     VALUES ($1, $2, $3, $4)`,
                    [nuevoConteoId, detalle.id_refaccion, detalle.cantidad, detalle.costo]
                );
                // Crea el LOTE inicial en el inventario
                await client.query(
                    `INSERT INTO lote_refaccion (id_refaccion, cantidad_disponible, costo_unitario_final, costo_unitario_subtotal, monto_iva_unitario)
                     VALUES ($1, $2, $3, $3, 0)`,
                    [detalle.id_refaccion, detalle.cantidad, detalle.costo]
                );
            }
        }
        
        // 3. Procesar los detalles de los INSUMOS (actualiza stock y costo promedio)
        if (detallesInsumos && detallesInsumos.length > 0) {
            for (const detalle of detallesInsumos) {
                // Guarda el registro de auditoría
                await client.query(
                    `INSERT INTO conteo_inventario_detalle_insumo (id_conteo, id_insumo, cantidad_contada, costo_unitario_asignado)
                     VALUES ($1, $2, $3, $4)`,
                    [nuevoConteoId, detalle.id_insumo, detalle.cantidad, detalle.costo]
                );
                
                // Actualiza el stock y el costo promedio del insumo
                // Esta lógica asume que el inventario inicial establece el nuevo costo promedio.
                await client.query(
                    'UPDATE insumo SET stock_actual = $1, costo_unitario_promedio = $2 WHERE id_insumo = $3',
                    [detalle.cantidad, detalle.costo, detalle.id_insumo]
                );
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ id_conteo: nuevoConteoId, message: 'Inventario inicial cargado exitosamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de carga de inventario inicial:', error);
        res.status(500).json({ message: 'Error al procesar la carga de inventario.' });
    } finally {
        client.release();
    }
});

module.exports = router;
