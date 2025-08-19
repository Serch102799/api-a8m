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
 * /api/entradas-insumo:
 *   get:
 *     summary: Obtener historial de entradas de insumos
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
 *                     example: 15
 *                   fecha_entrada:
 *                     type: string
 *                     format: date-time
 *                     example: "2025-08-17T10:30:00.000Z"
 *                   numero_factura:
 *                     type: string
 *                     example: "FAC-2025-001"
 *                   observaciones:
 *                     type: string
 *                     example: "Compra mensual de insumos de oficina"
 *                   nombre_proveedor:
 *                     type: string
 *                     example: "Papelería Central"
 *                   nombre_empleado:
 *                     type: string
 *                     example: "María González"
 *       500:
 *         description: Error interno al obtener entradas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Error al obtener entradas de insumos
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
        console.error('Error al obtener entradas de insumos:', error);
        res.status(500).json({ message: 'Error al obtener entradas de insumos' });
    }
});
/**
 * @swagger
 * /api/entradas-insumo:
 *   post:
 *     summary: Registrar una nueva entrada de insumos (maestro y detalles)
 *     description: >
 *       Crea un registro maestro de entrada de insumos y sus detalles.  
 *       Para cada detalle, calcula el costo unitario final (con/sin IVA)  
 *       y actualiza el stock y el costo promedio ponderado del insumo.
 *     tags: [EntradaInsumos]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [maestro, detalles]
 *             properties:
 *               maestro:
 *                 type: object
 *                 properties:
 *                   id_proveedor:
 *                     type: integer
 *                     example: 3
 *                   id_empleado:
 *                     type: integer
 *                     example: 7
 *                   numero_factura:
 *                     type: string
 *                     example: "FAC-2025-002"
 *                   observaciones:
 *                     type: string
 *                     example: "Compra de insumos de limpieza"
 *               detalles:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [id_insumo, cantidad_recibida, costo_ingresado, tipo_costo, aplica_iva]
 *                   properties:
 *                     id_insumo:
 *                       type: integer
 *                       example: 12
 *                     cantidad_recibida:
 *                       type: number
 *                       example: 100
 *                     costo_ingresado:
 *                       type: number
 *                       example: 2500
 *                     tipo_costo:
 *                       type: string
 *                       enum: [unitario, neto]
 *                       example: neto
 *                     aplica_iva:
 *                       type: boolean
 *                       example: true
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
 *                   example: 16
 *                 message:
 *                   type: string
 *                   example: Entrada de insumos registrada exitosamente
 *       400:
 *         description: Datos inválidos en la petición
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: La petición debe incluir un objeto "maestro" y un arreglo "detalles" con al menos un ítem.
 *       500:
  description: Error interno al registrar entrada de insumos
  content:
    application/json:
      schema:
        type: object
        properties:
          message:
            type: string
            example: "Error al procesar la entrada: El insumo con ID 99 no fue encontrado."

 */
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
    const { maestro, detalles } = req.body;
    
    if (!maestro || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
        return res.status(400).json({ message: 'La petición debe incluir un objeto "maestro" y un arreglo "detalles" con al menos un ítem.' });
    }
    
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
            const { id_insumo, cantidad_recibida, costo_ingresado, tipo_costo, aplica_iva } = detalle;
            const cantidadNueva = parseFloat(cantidad_recibida);

            if (!id_insumo || !cantidadNueva || cantidadNueva <= 0 || !costo_ingresado || costo_ingresado < 0 || !tipo_costo) {
                throw new Error('Cada detalle debe incluir id_insumo, cantidad y costo válidos.');
            }

            // --- Lógica de Cálculo de Costo ---
            let costoUnitarioSubtotal = 0;
            if (tipo_costo === 'unitario') {
                costoUnitarioSubtotal = parseFloat(costo_ingresado);
            } else if (tipo_costo === 'neto') {
                // Evita división por cero
                costoUnitarioSubtotal = cantidadNueva > 0 ? parseFloat(costo_ingresado) / cantidadNueva : 0;
            } else {
                throw new Error(`Tipo de costo '${tipo_costo}' no es válido.`);
            }

            const montoIvaUnitario = aplica_iva ? costoUnitarioSubtotal * 0.16 : 0;
            const costoUnitarioFinal = costoUnitarioSubtotal + montoIvaUnitario;
            
            // --- Actualización de Costo Promedio Ponderado y Stock ---
            const insumoActualResult = await client.query('SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id_insumo]);

            if (insumoActualResult.rows.length === 0) {
                throw new Error(`El insumo con ID ${id_insumo} no fue encontrado.`);
            }

            const stockViejo = parseFloat(insumoActualResult.rows[0].stock_actual);
            const costoViejo = parseFloat(insumoActualResult.rows[0].costo_unitario_promedio);
            
            const valorTotalViejo = stockViejo * costoViejo;
            const valorTotalNuevo = costoUnitarioFinal * cantidadNueva;
            const nuevoStockTotal = stockViejo + cantidadNueva;
            
            const nuevoCostoPromedio = nuevoStockTotal > 0 ? (valorTotalViejo + valorTotalNuevo) / nuevoStockTotal : 0;

            await client.query(
                `UPDATE insumo SET stock_actual = $1, costo_unitario_promedio = $2 WHERE id_insumo = $3`,
                [nuevoStockTotal, nuevoCostoPromedio.toFixed(4), id_insumo]
            );

            // --- Inserción en Tabla de Detalle con Costos Desglosados ---
            await client.query(
                `INSERT INTO detalle_entrada_insumo (id_entrada_insumo, id_insumo, cantidad_recibida, costo_unitario_subtotal, monto_iva_unitario, costo_unitario_final)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [nuevaEntradaId, id_insumo, cantidadNueva, costoUnitarioSubtotal.toFixed(2), montoIvaUnitario.toFixed(2), costoUnitarioFinal.toFixed(2)]
            );
        }

        await client.query('COMMIT');
        res.status(201).json({ id_entrada_insumo: nuevaEntradaId, message: 'Entrada de insumos registrada exitosamente' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de entrada de insumos:', error);
        res.status(500).json({ message: 'Error al procesar la entrada: ' + (error instanceof Error ? error.message : String(error)) });
    } finally {
        client.release();
    }
});

module.exports = router;