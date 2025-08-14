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
 *       - in: query
 *         name: vin
 *         schema:
 *           type: string
 *         description: VIN del autobús
 *       - in: query
 *         name: razon_social
 *         schema:
 *           type: string
 *           enum: [MARTRESS, A8M, TRESA, GIALJU]
 *         description: Razón social a la que pertenece el autobús
 *     responses:
 *       200:
 *         description: Lista de autobuses obtenida exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       500:
 *         description: Error al obtener autobuses
 */
router.get('/', async (req, res) => {
  const { economico, marca, modelo, anio, vin, razon_social } = req.query;
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
    if (razon_social) {
      baseQuery += ` AND razon_social = $${paramCount++}`;
      params.push(razon_social);
    }

    const result = await pool.query(baseQuery, params);
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener autobuses:", error);
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
 *     security:
 *       - bearerAuth: []   # Token JWT requerido
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Economico
 *               - Razon_Social
 *             properties:
 *               Economico:
 *                 type: string
 *                 example: "A8M-120"
 *               Marca:
 *                 type: string
 *                 example: "Mercedes-Benz"
 *               Modelo:
 *                 type: string
 *                 example: "Tourismo"
 *               Anio:
 *                 type: integer
 *                 example: 2021
 *               Kilometraje_Actual:
 *                 type: integer
 *                 example: 45000
 *               VIN:
 *                 type: string
 *                 example: "1M8PDMPA9KP042788"
 *               Razon_Social:
 *                 type: string
 *                 description: Razón social a la que pertenece el autobús.
 *                 enum: [MARTRESS, A8M, TRESA, GIALJU]
 *                 example: "A8M"
 *     responses:
 *       201:
 *         description: Autobús creado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Autobus'
 *       400:
 *         description: Error de validación o datos duplicados
 *       401:
 *         description: Token inválido o no proporcionado
 *       403:
 *         description: No tiene permisos para esta operación
 *       500:
 *         description: Error en el servidor
 */
router.post('/', [verifyToken, checkRole(['Admin'])], validateAutobus, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errores: errors.array() });
  }

  const { Economico, Marca, Modelo, Anio, Kilometraje_Actual, VIN, Razon_Social } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO autobus (economico, marca, modelo, anio, kilometraje_actual, vin, razon_social)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [Economico, Marca, Modelo, Anio, Kilometraje_Actual, VIN, Razon_Social]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      const message = error.constraint === 'autobus_vin_key' 
        ? 'El VIN ya está en uso por otro autobús.' 
        : 'El número económico ya está en uso.';
      return res.status(400).json({ message });
    }
    if (error.code === '23503' || error.code === '22P02') { 
        return res.status(400).json({ message: 'El valor de Razón Social no es válido.' });
    }
    res.status(500).json({ message: 'Error al crear el autobús' });
  }
});

/**
 * @swagger
 * /api/autobuses/{id}:
 *   put:
 *     summary: Actualizar un autobús existente por su ID
 *     tags: [Autobuses]
 *     security:
 *       - bearerAuth: []   # Token JWT requerido
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           example: 15
 *         description: ID numérico del autobús a actualizar
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               Marca:
 *                 type: string
 *                 example: "Mercedes-Benz"
 *               Modelo:
 *                 type: string
 *                 example: "Tourismo"
 *               Anio:
 *                 type: integer
 *                 example: 2022
 *               Kilometraje_Actual:
 *                 type: integer
 *                 example: 62000
 *               Razon_Social:
 *                 type: string
 *                 enum: [MARTRESS, A8M, TRESA, GIALJU]
 *                 example: "MARTRESS"
 *     responses:
 *       200:
 *         description: Autobús actualizado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Autobus'
 *       400:
 *         description: Datos inválidos o faltantes
 *       401:
 *         description: Token inválido o no proporcionado
 *       403:
 *         description: No tiene permisos para esta operación
 *       404:
 *         description: Autobús no encontrado
 *       500:
 *         description: Error en el servidor
 */

router.put('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
  const { id } = req.params; 
  const { Marca, Modelo, Anio, Kilometraje_Actual, Razon_Social } = req.body; 

  try {
    const result = await pool.query(
      `UPDATE Autobus 
       SET 
         Marca = $1, 
         Modelo = $2, 
         Anio = $3, 
         Kilometraje_Actual = $4,
         razon_social = $5
       WHERE ID_Autobus = $6
       RETURNING *`,
      [Marca, Modelo, Anio, Kilometraje_Actual, Razon_Social, id] 
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error al actualizar autobús:", error);
    res.status(500).json({ message: 'Error al actualizar el autobús' });
  }
});

/**
 * @swagger
 * /api/autobuses/{id}:
 *   delete:
 *     summary: Eliminar un autobús por su ID
 *     tags: [Autobuses]
 *     security:
 *       - bearerAuth: []   # Token JWT requerido
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *           example: 15
 *         description: ID numérico del autobús a eliminar
 *     responses:
 *       200:
 *         description: Autobús eliminado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Autobús eliminado exitosamente"
 *                 autobus:
 *                   $ref: '#/components/schemas/Autobus'
 *       400:
 *         description: No se puede eliminar el autobús porque tiene historial de mantenimiento asociado
 *       401:
 *         description: Token inválido o no proporcionado
 *       403:
 *         description: No tiene permisos para esta operación
 *       404:
 *         description: Autobús no encontrado
 *       500:
 *         description: Error al eliminar el autobús
 */

router.delete('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
  const { id } = req.params; 

  try {
    const result = await pool.query(
      'DELETE FROM Autobus WHERE ID_Autobus = $1 RETURNING *',
      [id] // CAMBIO: Se pasa el id como parámetro
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }
    res.json({ message: 'Autobús eliminado exitosamente', autobus: result.rows[0] });
  } catch (error) {
    console.error("Error al eliminar autobús:", error);
    if (error.code === '23503') {
      return res.status(400).json({ message: 'No se puede eliminar el autobús porque tiene historial de mantenimiento asociado.' });
    }
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

