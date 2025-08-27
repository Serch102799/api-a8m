const express = require('express');
const pool = require('../db');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   - name: DetalleEntrada
 *     description: Gestión de detalles de entrada de almacén
 */

/**
 * @swagger
 * /api/detalle-entrada:
 *   get:
 *     summary: Obtener todos los detalles de entrada
 *     tags: [DetalleEntrada]
 *     responses:
 *       200:
 *         description: Lista de todos los detalles de entrada
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM detalle_entrada');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los detalles de entrada' });
  }
});


/**
 * @swagger
 * /api/detalle-entrada/{idEntrada}:
 *   get:
 *     summary: Obtener todos los detalles de una entrada específica
 *     tags: [DetalleEntrada]
 *     parameters:
 *       - in: path
 *         name: idEntrada
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la entrada de almacén
 *     responses:
 *       200:
 *         description: Lista de detalles para la entrada solicitada
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_detalle_entrada:
 *                     type: integer
 *                   id_entrada:
 *                     type: integer
 *                   id_refaccion:
 *                     type: integer
 *                   cantidad:
 *                     type: integer
 *                   precio_unitario:
 *                     type: number
 *                   nombre_refaccion:
 *                     type: string
 */
router.get('/:idEntrada', async (req, res) => {
  const { idEntrada } = req.params;
  try {
    const result = await pool.query(
      `
      -- Seleccionar detalles de REFACCIONES
      (SELECT 
        r.nombre AS nombre_item,
        r.marca,
        de.cantidad_recibida AS cantidad,
        l.costo_unitario_final AS costo,
        'Refacción' AS tipo_item
      FROM detalle_entrada de
      JOIN refaccion r ON de.id_refaccion = r.id_refaccion
      JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
      WHERE de.id_entrada = $1)
      
      UNION ALL

      -- Seleccionar detalles de INSUMOS
      (SELECT 
        i.nombre AS nombre_item,
        i.marca,
        dei.cantidad_recibida AS cantidad,
        dei.costo_unitario_final AS costo,
        'Insumo' AS tipo_item
      FROM detalle_entrada_insumo dei
      JOIN insumo i ON dei.id_insumo = i.id_insumo
      WHERE dei.id_entrada = $1)
      `,
      [idEntrada]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(`Error al obtener detalles de la entrada ${idEntrada}:`, error);
    res.status(500).json({ message: 'Error al obtener los detalles de la entrada' });
  }
});

/**
 * @swagger
 * /api/entradas:
 *   post:
 *     summary: Registrar un nuevo detalle de entrada y su lote asociado
 *     description: >
 *       Permite registrar un detalle de entrada de refacciones en el almacén.
 *       Calcula automáticamente el costo unitario final considerando si el costo ingresado es neto o unitario,
 *       y si aplica IVA.
 *     tags: [EntradasAlmacen]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ID_Entrada
 *               - ID_Refaccion
 *               - Cantidad_Recibida
 *               - costo_ingresado
 *               - tipo_costo
 *             properties:
 *               ID_Entrada:
 *                 type: integer
 *                 example: 10
 *                 description: Identificador de la entrada principal
 *               ID_Refaccion:
 *                 type: integer
 *                 example: 25
 *                 description: Identificador de la refacción
 *               Cantidad_Recibida:
 *                 type: integer
 *                 example: 100
 *                 description: Cantidad de refacciones recibidas
 *               costo_ingresado:
 *                 type: number
 *                 format: float
 *                 example: 5000
 *                 description: Valor numérico ingresado por el usuario (puede ser costo total o unitario)
 *               tipo_costo:
 *                 type: string
 *                 enum: [unitario, neto]
 *                 example: unitario
 *                 description: Define si el costo ingresado es por unidad o total neto
 *               aplica_iva:
 *                 type: boolean
 *                 example: true
 *                 description: Indica si aplica IVA (16%) al costo
 *     responses:
 *       201:
 *         description: Detalle de entrada y lote creados exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Detalle de entrada y lote creados exitosamente
 *       400:
 *         description: Error en datos de entrada (faltan campos o valores inválidos)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Faltan datos requeridos para procesar la entrada.
 *       500:
 *         description: Error interno al procesar la transacción
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Error al procesar la entrada
 */

router.post('/', async (req, res) => {
  // CAMBIO: Recibimos los nuevos campos del frontend
  const { 
    ID_Entrada, 
    ID_Refaccion, 
    Cantidad_Recibida, 
    costo_ingresado, // El valor numérico que el usuario tecleó
    tipo_costo,      // Será 'unitario' o 'neto'
    aplica_iva       // Será true o false
  } = req.body;

  // --- Validación de datos de entrada ---
  if (!ID_Entrada || !ID_Refaccion || !Cantidad_Recibida || !costo_ingresado || !tipo_costo) {
    return res.status(400).json({ message: 'Faltan datos requeridos para procesar la entrada.' });
  }
  if (Cantidad_Recibida <= 0) {
    return res.status(400).json({ message: 'La cantidad debe ser mayor a cero.' });
  }

  // --- Lógica de Cálculo ---
  let costoUnitarioSubtotal = 0;
  if (tipo_costo === 'unitario') {
    costoUnitarioSubtotal = parseFloat(costo_ingresado);
  } else if (tipo_costo === 'neto') {
    costoUnitarioSubtotal = parseFloat(costo_ingresado) / Cantidad_Recibida;
  }

  const montoIvaUnitario = aplica_iva ? costoUnitarioSubtotal * 0.16 : 0;
  const costoUnitarioFinal = costoUnitarioSubtotal + montoIvaUnitario;

  // --- Transacción en la Base de Datos ---
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const detalleResult = await client.query(
      // Se usa el costo final calculado para el detalle de entrada
      `INSERT INTO detalle_entrada (id_entrada, id_refaccion, cantidad_recibida, costo_unitario_entrada)
       VALUES ($1, $2, $3, $4) RETURNING id_detalle_entrada`,
      [ID_Entrada, ID_Refaccion, Cantidad_Recibida, costoUnitarioFinal]
    );
    const nuevoDetalleId = detalleResult.rows[0].id_detalle_entrada;

    // Se guarda el desglose completo en la tabla de lotes
    await client.query(
      `INSERT INTO lote_refaccion (id_refaccion, id_detalle_entrada, cantidad_disponible, costo_unitario_subtotal, monto_iva_unitario, costo_unitario_final)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [ID_Refaccion, nuevoDetalleId, Cantidad_Recibida, costoUnitarioSubtotal, montoIvaUnitario, costoUnitarioFinal]
    );

    await client.query('COMMIT');
    res.status(201).json({ message: 'Detalle de entrada y lote creados exitosamente' });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de entrada:', error);
    res.status(500).json({ message: 'Error al procesar la entrada' });
  } finally {
    client.release();
  }
});

module.exports = router;
