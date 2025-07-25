const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();
const validateAutobus = [
  body('Economico').notEmpty().withMessage('Número económico es requerido'),
  body('VIN').isLength({ min: 17, max: 17 }).withMessage('El VIN debe tener almenos 17 caracteres'),
];
/**
 * @swagger
 * tags:
 *   name: Autobuses
 *   description: Gestión de autobuses
 */

/**
 * @swagger
 * /api/autobuses:
 *   get:
 *     summary: Obtener todos los autobuses o filtrar por parámetros
 *     tags: [Autobuses]
 *     parameters:
 *       - in: query
 *         name: economico
 *         schema:
 *           type: string
 *         description: Número económico (busca coincidencias)
 *       - in: query
 *         name: marca
 *         schema:
 *           type: string
 *         description: Marca del autobús
 *       - in: query
 *         name: modelo
 *         schema:
 *           type: string
 *         description: Modelo del autobús
 *       - in: query
 *         name: anio
 *         schema:
 *           type: integer
 *         description: Año del autobús
 *     responses:
 *       200:
 *         description: Lista de autobuses
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 */
router.get('/', async (req, res) => {
  const { economico, marca, modelo, anio, vin } = req.query;
  try {
    let baseQuery = 'SELECT * FROM autobus WHERE 1=1';
    const params = [];
    let paramCount = 1;

    if (economico) {
      baseQuery += ` AND economico ILIKE $${paramCount++}`;
      params.push(`%${economico}%`);
    }
    if (marca) {
      baseQuery += ` AND marca ILIKE $${paramCount++}`;
      params.push(`%${marca}%`);
    }
    if (modelo) {
      baseQuery += ` AND modelo ILIKE $${paramCount++}`;
      params.push(`%${modelo}%`);
    }
    if (anio) {
      baseQuery += ` AND anio = $${paramCount++}`;
      params.push(anio);
    }
    if (vin) {
      baseQuery += ` AND vin ILIKE $${paramCount++}`;
      params.push(`%${vin}%`);
    }

    const result = await pool.query(baseQuery, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener autobuses' });
  }
});

/**
 * @swagger
 * /api/autobuses/{economico}:
 *   get:
 *     summary: Obtener un autobús por número económico
 *     tags: [Autobuses]
 *     parameters:
 *       - in: path
 *         name: economico
 *         required: true
 *         schema:
 *           type: string
 *         description: Número económico del autobús
 *     responses:
 *       200:
 *         description: Autobús encontrado
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Autobús no encontrado
 */
router.get('/:economico', async (req, res) => {
  const { economico } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM Autobus WHERE Economico = $1',
      [economico]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener el autobús' });
  }
});

/**
 * @swagger
 * /api/autobuses:
 *   post:
 *     summary: Crear un nuevo autobús
 *     tags: [Autobuses]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Economico
 *             properties:
 *               Economico:
 *                 type: string
 *               Marca:
 *                 type: string
 *               Modelo:
 *                 type: string
 *               Anio:
 *                 type: integer
 *               Kilometraje_Actual:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Autobús creado exitosamente
 *       400:
 *         description: Error de validación o número económico duplicado
 */
router.post('/', [verifyToken, checkRole(['Admin'])], validateAutobus, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errores: errors.array() });
  }
  const { Economico, Marca, Modelo, Anio, Kilometraje_Actual, VIN } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO autobus (economico, marca, modelo, anio, kilometraje_actual, vin)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [Economico, Marca, Modelo, Anio, Kilometraje_Actual, VIN]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // Error de valor duplicado
      const message = error.constraint === 'autobus_vin_key' 
        ? 'El VIN ya está en uso por otro autobús.' 
        : 'El número económico ya está en uso.';
      return res.status(400).json({ message });
    }
    res.status(500).json({ message: 'Error al crear el autobús' });
  }
});

/**
 * @swagger
 * /api/autobuses/{economico}:
 *   put:
 *     summary: Actualizar un autobús existente (por número económico)
 *     tags: [Autobuses]
 *     parameters:
 *       - in: path
 *         name: economico
 *         required: true
 *         schema:
 *           type: string
 *         description: Número económico del autobús
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               Marca:
 *                 type: string
 *               Modelo:
 *                 type: string
 *               Anio:
 *                 type: integer
 *               Kilometraje_Actual:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Autobús actualizado exitosamente
 *       404:
 *         description: Autobús no encontrado
 */
router.put('/:economico', async (req, res) => {
  const { economico } = req.params;
  const { Marca, Modelo, Anio, Kilometraje_Actual } = req.body;

  try {
    const result = await pool.query(
      `UPDATE Autobus SET Marca = $1, Modelo = $2, Anio = $3, Kilometraje_Actual = $4
       WHERE Economico = $5
       RETURNING *`,
      [Marca, Modelo, Anio, Kilometraje_Actual, economico]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el autobús' });
  }
});

/**
 * @swagger
 * /api/autobuses/{economico}:
 *   delete:
 *     summary: Eliminar un autobús por número económico
 *     tags: [Autobuses]
 *     parameters:
 *       - in: path
 *         name: economico
 *         required: true
 *         schema:
 *           type: string
 *         description: Número económico del autobús
 *     responses:
 *       200:
 *         description: Autobús eliminado exitosamente
 *       404:
 *         description: Autobús no encontrado
 */
router.delete('/:economico', async (req, res) => {
  const { economico } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM Autobus WHERE Economico = $1 RETURNING *',
      [economico]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }
    res.json({ message: 'Autobús eliminado', autobus: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el autobús' });
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
 *                     example: 1
 *                   id_entrada:
 *                     type: integer
 *                     example: 10
 *                   id_refaccion:
 *                     type: integer
 *                     example: 3
 *                   cantidad:
 *                     type: integer
 *                     example: 50
 *                   precio_unitario:
 *                     type: number
 *                     format: float
 *                     example: 75.5
 *                   nombre_refaccion:
 *                     type: string
 *                     example: Bujía NGK
 */

router.get('/:idEntrada', async (req, res) => {
  const { idEntrada } = req.params;
  try {
    const result = await pool.query(
      `SELECT de.*, r.nombre as nombre_refaccion 
       FROM detalle_entrada de
       JOIN refaccion r ON de.id_refaccion = r.id_refaccion
       WHERE de.id_entrada = $1`,
      [idEntrada]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener los detalles de la entrada:', error);
    res.status(500).json({ message: 'Error al obtener los detalles de la entrada' });
  }
});

module.exports = router;

