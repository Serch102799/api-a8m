const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

/**
 * @swagger
 * tags:
 *   name: Lotes
 *   description: Operaciones relacionadas con los lotes de refacciones
 */

/**
 * @swagger
 * /api/lotes/{idRefaccion}:
 *   get:
 *     summary: Obtener los lotes disponibles de una refacción específica (FIFO)
 *     tags: [Lotes]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: idRefaccion
 *         schema:
 *           type: integer
 *         required: true
 *         description: ID de la refacción para consultar sus lotes disponibles
 *     responses:
 *       200:
 *         description: Lista de lotes disponibles de la refacción
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_lote:
 *                     type: integer
 *                   id_refaccion:
 *                     type: integer
 *                   cantidad_disponible:
 *                     type: number
 *                   fecha_ingreso:
 *                     type: string
 *                     format: date
 *                   id_detalle_entrada:
 *                     type: integer
 *                   nombre_proveedor:
 *                     type: string
 *       500:
 *         description: Error al obtener lotes
 */

// Obtener lotes por id_refaccion
router.get('/:idRefaccion', async (req, res) => {
  const { idRefaccion } = req.params;
  try {
    const result = await pool.query(
      `SELECT l.*, p.nombre_proveedor 
       FROM lote_refaccion l
       LEFT JOIN detalle_entrada de ON l.id_detalle_entrada = de.id_detalle_entrada
       LEFT JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada
       LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
       WHERE l.id_refaccion = $1 AND l.cantidad_disponible > 0
       ORDER BY l.fecha_ingreso ASC`, // FIFO: los más antiguos primero
      [idRefaccion]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener lotes' });
  }
});

module.exports = router;