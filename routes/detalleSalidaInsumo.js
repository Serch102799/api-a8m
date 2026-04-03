const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);
/**
 * @swagger
 * tags:
 *   name: DetalleSalidaInsumo
 *   description: Operaciones relacionadas con la salida de insumos
 */

/**
 * @swagger
 * /api/detalle-salida-insumo:
 *   post:
 *     summary: Crea un nuevo detalle de salida de insumo y actualiza el stock
 *     tags: [DetalleSalidaInsumo]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - id_salida
 *               - id_insumo
 *               - cantidad_usada
 *             properties:
 *               id_salida:
 *                 type: integer
 *                 description: ID de la salida de insumo
 *               id_insumo:
 *                 type: integer
 *                 description: ID del insumo a usar
 *               cantidad_usada:
 *                 type: number
 *                 description: Cantidad del insumo que se usa
 *     responses:
 *       201:
 *         description: Registro de salida de insumo creado exitosamente
 *       400:
 *         description: Error de validación
 *       500:
 *         description: Error en el servidor
 */
router.post('/', async (req, res) => {
  const { id_salida, id_insumo, cantidad_usada } = req.body;

  // 1. BLINDAJE EXTRA: Verificar que vengan los IDs clave
  if (!id_salida || !id_insumo) {
    return res.status(400).json({ message: 'Faltan datos clave: id_salida o id_insumo son requeridos.' });
  }

  // 2. Verificar que la cantidad sea válida
  if (!cantidad_usada || cantidad_usada <= 0) {
    return res.status(400).json({ message: 'La cantidad debe ser un número positivo mayor a cero.' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Verificar existencia y stock del insumo, bloqueando la fila (FOR UPDATE)
    const insumoResult = await client.query(
      'SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE',
      [id_insumo]
    );

    if (insumoResult.rows.length === 0) {
      throw new Error('El insumo especificado no existe en el catálogo.');
    }

    const stockActual = parseFloat(insumoResult.rows[0].stock_actual);
    const costoActual = parseFloat(insumoResult.rows[0].costo_unitario_promedio);

    // Validar si alcanza el stock
    if (stockActual < cantidad_usada) {
      throw new Error(`Stock insuficiente. Disponible: ${stockActual}, Solicitado: ${cantidad_usada}`);
    }

    // Actualizar (descontar) stock
    await client.query(
      'UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2',
      [cantidad_usada, id_insumo]
    );

    // Insertar detalle en el vale
    const detalleResult = await client.query(
      `INSERT INTO detalle_salida_insumo (id_salida, id_insumo, cantidad_usada, costo_al_momento)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id_salida, id_insumo, cantidad_usada, costoActual]
    );

    await client.query('COMMIT');
    res.status(201).json(detalleResult.rows[0]);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de salida de insumo:', error);
    // Mandamos el mensaje exacto del throw (ej. "Stock insuficiente") al frontend
    res.status(500).json({ message: error.message || 'Error al registrar la salida del insumo' });
  } finally {
    client.release();
  }
});

module.exports = router;