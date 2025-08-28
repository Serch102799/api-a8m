// routes/salidaAlmacen.js
const express = require('express');
const pool = require('../db');
const verifyToken = require('..//middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Salidas
 *   description: Gestión de salidas del almacén
 */

/**
 * @swagger
 * /api/salidas:
 *   post:
 *     summary: Registrar una nueva salida
 *     tags: [Salidas]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Tipo_Salida
 *               - ID_Autobus
 *               - Solicitado_Por_ID
 *             properties:
 *               Tipo_Salida:
 *                 type: string
 *               ID_Autobus:
 *                 type: integer
 *               Solicitado_Por_ID:
 *                 type: integer
 *               Observaciones:
 *                 type: string
 *     responses:
 *       201:
 *         description: Salida registrada correctamente
 */
router.post('/', async (req, res) => {
  const { Tipo_Salida, ID_Autobus, Solicitado_Por_ID, Observaciones, Kilometraje_Autobus } = req.body;
  const client = await pool.connect(); 

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO salida_almacen (tipo_salida, id_autobus, solicitado_por_id, observaciones, kilometraje_autobus)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [Tipo_Salida, ID_Autobus, Solicitado_Por_ID, Observaciones, Kilometraje_Autobus]
    );
    if (ID_Autobus && Kilometraje_Autobus) {
      await client.query(
        `UPDATE autobus 
         SET kilometraje_actual = $1 
         WHERE id_autobus = $2 AND $1 > kilometraje_actual`,
        [Kilometraje_Autobus, ID_Autobus]
      );
    }
    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);

  } catch (error) {
    await client.query('ROLLBACK'); 
    console.error('Error al registrar salida:', error);
    res.status(500).json({ message: 'Error al registrar salida' });
  } finally {
    client.release(); 
  }
});

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.*, 
        a.Economico as economico_autobus, 
        e.Nombre as nombre_empleado
      FROM Salida_Almacen s
      LEFT JOIN Autobus a ON s.ID_Autobus = a.ID_Autobus
      LEFT JOIN Empleado e ON s.Solicitado_Por_ID = e.ID_Empleado
      ORDER BY s.Fecha_Operacion DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener salidas:', error);
    res.status(500).json({ message: 'Error al obtener salidas' });
  }
});

/**
 * @swagger
 * /api/salidas:
 *   get:
 *     summary: Obtener todas las salidas
 *     tags: [Salidas]
 *     responses:
 *       200:
 *         description: Lista de salidas
 */
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Salida_Almacen');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener salidas:', error);
    res.status(500).json({ message: 'Error al obtener salidas' });
  }
});
/**
 * @swagger
 * /api/detalles/{idSalida}:
 *   get:
 *     summary: Obtiene los detalles de una salida (refacciones e insumos)
 *     tags: [DetalleSalidaInsumo]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idSalida
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID de la salida que se desea consultar
 *     responses:
 *       200:
 *         description: Lista de insumos y refacciones asociados a la salida
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   nombre:
 *                     type: string
 *                     description: Nombre del insumo o refacción
 *                   cantidad:
 *                     type: number
 *                     description: Cantidad usada o despachada
 *                   tipo:
 *                     type: string
 *                     enum: [Refacción, Insumo]
 *                     description: Tipo del artículo
 *       500:
 *         description: Error al obtener detalles de la salida
 */
router.get('/detalles/:idSalida', verifyToken, async (req, res) => {
  const { idSalida } = req.params;
  try {
    const query = `
      SELECT nombre, cantidad, tipo FROM (
        SELECT r.nombre, ds.cantidad_despachada as cantidad, 'Refacción' as tipo
        FROM detalle_salida ds
        JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
        WHERE ds.id_salida = $1

        UNION ALL

        SELECT i.nombre, dsi.cantidad_usada as cantidad, 'Insumo' as tipo
        FROM detalle_salida_insumo dsi
        JOIN insumo i ON dsi.id_insumo = i.id_insumo
        WHERE dsi.id_salida = $1
      ) as detalles;
    `;
    const result = await pool.query(query, [idSalida]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener detalles:', error);
    res.status(500).json({ message: 'Error al obtener detalles de la salida' });
  }
});



module.exports = router;
