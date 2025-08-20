const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
/**
 * @swagger
 * tags:
 *   - name: Insumos
 *     description: Gestión de insumos y consumibles del taller
 */

/**
 * @swagger
 * /api/insumos:
 *   get:
 *     summary: Obtener todos los insumos
 *     tags: [Insumos]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Lista de insumos
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_insumo:
 *                     type: integer
 *                     example: 1
 *                   nombre:
 *                     type: string
 *                     example: "Aceite 15W-40"
 *                   marca:
 *                     type: string
 *                     example: "Castrol"
 *                   tipo:
 *                     type: string
 *                     example: "Lubricante"
 *                   unidad_medida:
 *                     type: string
 *                     example: "Litros"
 *                   stock_minimo:
 *                     type: number
 *                     example: 5
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM insumo ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener los insumos' });
  }
});

/**
 * @swagger
 * /api/insumos:
 *   post:
 *     summary: Crear un nuevo insumo (Solo Admins)
 *     tags: [Insumos]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - nombre
 *               - unidad_medida
 *             properties:
 *               nombre:
 *                 type: string
 *                 example: "Desengrasante"
 *               marca:
 *                 type: string
 *                 example: "WD-40"
 *               tipo:
 *                 type: string
 *                 example: "Limpiador"
 *               unidad_medida:
 *                 type: string
 *                 example: "Mililitros"
 *     responses:
 *       201:
 *         description: Insumo creado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id_insumo:
 *                   type: integer
 *                   example: 10
 *                 nombre:
 *                   type: string
 *                   example: "Desengrasante"
 *                 marca:
 *                   type: string
 *                   example: "WD-40"
 *                 tipo:
 *                   type: string
 *                   example: "Limpiador"
 *                 unidad_medida:
 *                   type: string
 *                   example: "Mililitros"
 *       400:
 *         description: Error de validación o nombre duplicado
 *       500:
 *         description: Error interno del servidor
 */
router.post('/', [verifyToken, checkRole(['Admin'])], async (req, res) => {
  const { nombre, marca, tipo, unidad_medida } = req.body;
  if (!nombre || !unidad_medida) {
    return res.status(400).json({ message: 'Nombre y Unidad de Medida son requeridos.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO insumo (nombre, marca, tipo, unidad_medida) VALUES ($1, $2, $3, $4) RETURNING *',
      [nombre, marca, tipo, unidad_medida]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ message: 'El nombre de este insumo ya existe.' });
    }
    res.status(500).json({ message: 'Error al crear el insumo' });
  }
});

/**
 * @swagger
 * /api/insumos/{id}:
 *   put:
 *     summary: Actualizar un insumo (Solo Admins)
 *     tags: [Insumos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del insumo a actualizar
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - stock_minimo
 *             properties:
 *               stock_minimo:
 *                 type: number
 *                 example: 15
 *     responses:
 *       200:
 *         description: Insumo actualizado exitosamente
 *       404:
 *         description: Insumo no encontrado
 *       500:
 *         description: Error al actualizar el insumo
 */
router.put('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
    const { id } = req.params;
    const { stock_minimo } = req.body;
    try {
        const result = await pool.query(
            'UPDATE insumo SET stock_minimo = $1 WHERE id_insumo = $2 RETURNING *',
            [stock_minimo, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Insumo no encontrado' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar el insumo' });
    }
});

/**
 * @swagger
 * /api/insumos/{id}:
 *   delete:
 *     summary: Eliminar un insumo (Solo Admins)
 *     tags: [Insumos]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del insumo a eliminar
 *     responses:
 *       200:
 *         description: Insumo eliminado exitosamente
 *       404:
 *         description: Insumo no encontrado
 *       500:
 *         description: Error al eliminar insumo. Puede estar en uso.
 */
router.delete('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM insumo WHERE id_insumo = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Insumo no encontrado' });
        }
        res.json({ message: 'Insumo eliminado' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar insumo. Puede que esté en uso en algún registro.' });
    }
});
router.get('/buscar', verifyToken, async (req, res) => {
  const { term } = req.query;

  if (!term || term.length < 2) {
    return res.json([]);
  }

  try {
    const searchTerm = `%${term}%`;
    const result = await pool.query(
      `SELECT id_insumo, nombre, marca, tipo, stock_actual, unidad_medida 
       FROM insumo 
       WHERE nombre ILIKE $1 OR marca ILIKE $1 OR tipo ILIKE $1
       ORDER BY nombre ASC
       LIMIT 10`,
      [searchTerm]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en búsqueda de insumos:', error);
    res.status(500).json({ message: 'Error al buscar insumos' });
  }
});

module.exports = router;
