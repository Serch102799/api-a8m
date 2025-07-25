const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
/**
 * @swagger
 * tags:
 *   - name: EntradaInsumos
 *     description: Gestión de entradas de insumos (maestro y detalles)
 */

/**
 * @swagger
 * /api/entrada-insumo:
 *   get:
 *     summary: Obtener historial de entradas de insumos
 *     description: Lista todas las entradas de insumo, incluyendo datos del proveedor y empleado que registró la entrada.
 *     tags: [EntradaInsumos]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Historial de entradas obtenido correctamente
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_entrada_insumo:
 *                     type: integer
 *                     example: 42
 *                   id_proveedor:
 *                     type: integer
 *                     example: 3
 *                   id_empleado:
 *                     type: integer
 *                     example: 5
 *                   numero_factura:
 *                     type: string
 *                     example: "FAC-2025-001"
 *                   observaciones:
 *                     type: string
 *                     example: "Entrega parcial, faltan 2 cajas"
 *                   fecha_entrada:
 *                     type: string
 *                     format: date-time
 *                     example: "2025-07-20T14:35:00Z"
 *                   nombre_proveedor:
 *                     type: string
 *                     example: "Proveedor XYZ"
 *                   nombre_empleado:
 *                     type: string
 *                     example: "María López"
 *       500:
 *         description: Error interno al obtener entradas
 */
router.get('/', verifyToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT ei.*, p.nombre_proveedor, e.nombre as nombre_empleado
            FROM entrada_insumo ei
            LEFT JOIN proveedor p ON ei.id_proveedor = p.id_proveedor
            JOIN empleado e ON ei.id_empleado = e.id_empleado
            ORDER BY ei.fecha_entrada DESC
        `);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener entradas de insumos' });
    }
});
/**
 * @swagger
 * /api/entrada-insumo:
 *   post:
 *     summary: Registrar una nueva entrada de insumos (maestro y detalles)
 *     description: Crea un registro maestro de entrada de insumos y sus detalles. Calcula y actualiza stock y costo promedio de cada insumo involucrado.
 *     tags: [EntradaInsumos]
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
 *                   - id_proveedor
 *                   - id_empleado
 *                   - numero_factura
 *                 properties:
 *                   id_proveedor:
 *                     type: integer
 *                     example: 3
 *                   id_empleado:
 *                     type: integer
 *                     example: 5
 *                   numero_factura:
 *                     type: string
 *                     example: "FAC-2025-002"
 *                   observaciones:
 *                     type: string
 *                     example: "Ingreso completo sin observaciones"
 *               detalles:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required:
 *                     - id_insumo
 *                     - cantidad_recibida
 *                     - costo_total_compra
 *                   properties:
 *                     id_insumo:
 *                       type: integer
 *                       example: 7
 *                     cantidad_recibida:
 *                       type: number
 *                       example: 150
 *                     costo_total_compra:
 *                       type: number
 *                       format: float
 *                       example: 1125.50
 *     responses:
 *       201:
 *         description: Entrada de insumos registrada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id_entrada_insumo:
 *                   type: integer
 *                   example: 43
 *                 message:
 *                   type: string
 *                   example: "Entrada de insumos registrada exitosamente"
 *       400:
 *         description: Petición mal formada o datos faltantes
 *       401:
 *         description: No autorizado – token inválido o ausente
 *       403:
 *         description: Prohibido – rol insuficiente (solo Admin o Almacenista)
 *       500:
 *         description: Error interno al procesar la entrada
 */
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
    const { maestro, detalles } = req.body;
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const entradaResult = await client.query(
            `INSERT INTO entrada_insumo (id_proveedor, id_empleado, numero_factura, observaciones)
             VALUES ($1, $2, $3, $4) RETURNING id_entrada_insumo`,
            [maestro.id_proveedor, maestro.id_empleado, maestro.numero_factura, maestro.observaciones]
        );
        const nuevaEntradaId = entradaResult.rows[0].id_entrada_insumo;

        for (const detalle of detalles) {
            const insumoActual = await client.query(
                'SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE',
                [detalle.id_insumo]
            );

            const stockViejo = parseFloat(insumoActual.rows[0].stock_actual);
            const costoViejo = parseFloat(insumoActual.rows[0].costo_unitario_promedio);
            const cantidadNueva = parseFloat(detalle.cantidad_recibida);
            const costoTotalNuevo = parseFloat(detalle.costo_total_compra);
            const costoUnitarioNuevo = costoTotalNuevo / cantidadNueva;

            const valorTotalViejo = stockViejo * costoViejo;
            const nuevoStockTotal = stockViejo + cantidadNueva;
            const nuevoCostoPromedio = (valorTotalViejo + costoTotalNuevo) / nuevoStockTotal;

            await client.query(
                `UPDATE insumo SET stock_actual = $1, costo_unitario_promedio = $2 
                 WHERE id_insumo = $3`,
                [nuevoStockTotal, nuevoCostoPromedio, detalle.id_insumo]
            );

            await client.query(
                `INSERT INTO detalle_entrada_insumo (id_entrada_insumo, id_insumo, cantidad_recibida, costo_total_compra)
                 VALUES ($1, $2, $3, $4)`,
                [nuevaEntradaId, detalle.id_insumo, cantidadNueva, costoTotalNuevo]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ id_entrada_insumo: nuevaEntradaId, message: 'Entrada de insumos registrada exitosamente' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de entrada de insumos:', error);
        res.status(500).json({ message: error.message || 'Error al procesar la entrada' });
    } finally {
        client.release();
    }
});

module.exports = router;