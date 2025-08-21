const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Refacciones
 *   description: Gestión de refacciones
 */

/**
 * @swagger
 * /api/refacciones:
 *   get:
 *     summary: Obtener todas las refacciones
 *     tags: [Refacciones]
 *     responses:
 *       200:
 *         description: Lista de refacciones
 */
router.get('/', async (req, res) => {
  try {
    // La consulta ahora suma el stock de la tabla de lotes
    const result = await pool.query(`
      SELECT 
        r.*, 
        COALESCE(SUM(l.cantidad_disponible), 0) as stock_actual
      FROM refaccion r
      LEFT JOIN lote_refaccion l ON r.id_refaccion = l.id_refaccion
      GROUP BY r.id_refaccion
      ORDER BY r.nombre ASC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones' });
  }
});

/**
 * @swagger
 * /api/refacciones/nombre/{nombre}:
 *   get:
 *     summary: Obtener una refacción por nombre
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: nombre
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Refacción encontrada
 *       404:
 *         description: Refacción no encontrada
 */
router.get('/nombre/:nombre', async (req, res) => {
  try {
    const { nombre } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Nombre) = LOWER($1)', [nombre]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Refacción no encontrada' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la refacción' });
  }
});

/**
 * @swagger
 * /api/refacciones/categoria/{categoria}:
 *   get:
 *     summary: Obtener refacciones por categoría
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: categoria
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de refacciones por categoría
 */
router.get('/categoria/:categoria', async (req, res) => {
  try {
    const { categoria } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Categoria) = LOWER($1)', [categoria]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones por categoría' });
  }
});

/**
 * @swagger
 * /api/refacciones/marca/{marca}:
 *   get:
 *     summary: Obtener refacciones por marca
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: marca
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Lista de refacciones por marca
 */
router.get('/marca/:marca', async (req, res) => {
  try {
    const { marca } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Marca) = LOWER($1)', [marca]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones por marca' });
  }
});

/**
 * @swagger
 * /api/refacciones:
 *   post:
 *     summary: Crear una nueva refacción
 *     tags: [Refacciones]
 *     security:
 *       - bearerAuth: []   # Token JWT requerido
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Nombre
 *               - Unidad_Medida
 *             properties:
 *               Nombre:
 *                 type: string
 *                 example: "Filtro de aceite"
 *               Numero_Parte:
 *                 type: string
 *                 example: "FA-12345"
 *               Categoria:
 *                 type: string
 *                 example: "Motor"
 *               Marca:
 *                 type: string
 *                 example: "Bosch"
 *               Unidad_Medida:
 *                 type: string
 *                 example: "Pieza"
 *               Ubicacion_Almacen:
 *                 type: string
 *                 example: "Pasillo 3 - Estante B"
 *               Stock_Minimo:
 *                 type: integer
 *                 example: 5
 *               Stock_Maximo:
 *                 type: integer
 *                 example: 50
 *               Proveedor_Principal_ID:
 *                 type: integer
 *                 example: 2
 *               Descripcion:
 *                 type: string
 *                 description: Notas sobre el uso o aplicación de la refacción. (Campo opcional)
 *                 example: "Se utiliza en motores diésel serie XZ."
 *     responses:
 *       201:
 *         description: Refacción creada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Refaccion'
 *       400:
 *         description: Datos inválidos o refacción duplicada
 *       401:
 *         description: Token inválido o no proporcionado
 *       403:
 *         description: No tiene permisos para esta operación
 *       500:
 *         description: Error en el servidor
 */
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
 
  const {
    Nombre,
    Numero_Parte,
    Categoria,
    Marca,
    Unidad_Medida,
    Ubicacion_Almacen,
    Stock_Minimo,
    Descripcion 
  } = req.body;

  if (!Nombre || !Unidad_Medida) {
    return res.status(400).json({ message: 'Nombre y Unidad de Medida son requeridos.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO refaccion (nombre, numero_parte, categoria, marca, unidad_medida, ubicacion_almacen, stock_minimo, descripcion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
       RETURNING *`,
      [Nombre, Numero_Parte, Categoria, Marca, Unidad_Medida, Ubicacion_Almacen, Stock_Minimo, Descripcion]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { 
      return res.status(400).json({ message: 'Una refacción con ese nombre o número de parte ya existe.' });
    }
    console.error('Error al crear refacción:', error);
    res.status(500).json({ message: 'Error al crear la refacción' });
  }
});

/**
 * @swagger
 * /api/refacciones/{id}:
 *   put:
 *     summary: Editar una refacción existente por su ID
 *     tags: [Refacciones]
 *     security:
 *       - bearerAuth: []   # Token JWT requerido
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: ID numérico de la refacción a editar
 *         schema:
 *           type: integer
 *           example: 12
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - Nombre
 *             properties:
 *               Nombre:
 *                 type: string
 *                 example: "Filtro de aceite premium"
 *               Numero_Parte:
 *                 type: string
 *                 example: "FA-12345"
 *               Categoria:
 *                 type: string
 *                 example: "Motor"
 *               Marca:
 *                 type: string
 *                 example: "Bosch"
 *               Descripcion:
 *                 type: string
 *                 example: "Compatible con motores diésel serie XZ"
 *               Unidad_Medida:
 *                 type: string
 *                 example: "Pieza"
 *               Ubicacion_Almacen:
 *                 type: string
 *                 example: "Pasillo 3 - Estante B"
 *               Stock_Minimo:
 *                 type: integer
 *                 example: 5
 *               Stock_Maximo:
 *                 type: integer
 *                 example: 50
 *               Precio_Costo:
 *                 type: number
 *                 format: float
 *                 example: 125.50
 *     responses:
 *       200:
 *         description: Refacción actualizada exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Refaccion'
 *       400:
 *         description: Datos inválidos o faltantes
 *       401:
 *         description: Token inválido o no proporcionado
 *       403:
 *         description: No tiene permisos para esta operación
 *       404:
 *         description: Refacción no encontrada
 *       500:
 *         description: Error en el servidor
 */

router.put('/:id', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
  const { id } = req.params;
  
  // 1. Se elimina 'Precio_Costo' de las variables a recibir
  const {
    Nombre,
    Numero_Parte,
    Categoria,
    Marca,
    Descripcion,
    Unidad_Medida,
    Ubicacion_Almacen,
    Stock_Minimo,
    Stock_Maximo
  } = req.body;

  if (!Nombre) {
    return res.status(400).json({ message: 'El campo Nombre es requerido.' });
  }

  try {
    const result = await pool.query(
      `UPDATE refaccion 
       SET 
         nombre = $1, 
         numero_parte = $2, 
         categoria = $3, 
         marca = $4, 
         descripcion = $5, 
         unidad_medida = $6, 
         ubicacion_almacen = $7, 
         stock_minimo = $8, 
         stock_maximo = $9 -- 2. Se elimina la línea de 'precio_costo'
       WHERE id_refaccion = $10 -- 3. El placeholder para el ID ahora es $10
       RETURNING *`,
      [ // 4. Se elimina 'Precio_Costo' del arreglo de parámetros
        Nombre,
        Numero_Parte,
        Categoria,
        Marca,
        Descripcion,
        Unidad_Medida,
        Ubicacion_Almacen,
        Stock_Minimo,
        Stock_Maximo,
        id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Refacción no encontrada.' });
    }

    res.status(200).json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar la refacción:', error);
    res.status(500).json({ message: 'Error al actualizar la refacción' });
  }
});

/**
 * @swagger
 * /api/refacciones/nombre/{nombre}:
 *   delete:
 *     summary: Eliminar una refacción por nombre
 *     tags: [Refacciones]
 *     parameters:
 *       - in: path
 *         name: nombre
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Refacción eliminada
 */
router.delete('/nombre/:nombre', async (req, res) => {
  const { nombre } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM Refaccion WHERE LOWER(Nombre) = LOWER($1) RETURNING *',
      [nombre]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Refacción no encontrada' });
    }

    res.json({ message: 'Refacción eliminada', refaccion: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar refacción' });
  }
});
/**
 * @swagger
 * /api/refacciones/buscar:
 *   get:
 *     summary: Buscar refacciones para un autocomplete
 *     description: Permite buscar refacciones por nombre, marca o número de parte. Se requiere al menos 2 caracteres.
 *     tags: [Refacciones]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: term
 *         required: true
 *         schema:
 *           type: string
 *         description: Término de búsqueda para nombre, marca o número de parte.
 *     responses:
 *       200:
 *         description: Lista de refacciones que coinciden
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id_refaccion:
 *                     type: integer
 *                     description: ID único de la refacción
 *                     example: 12
 *                   nombre:
 *                     type: string
 *                     description: Nombre de la refacción
 *                     example: "Filtro de aceite"
 *                   marca:
 *                     type: string
 *                     description: Marca de la refacción
 *                     example: "Bosch"
 *                   numero_parte:
 *                     type: string
 *                     description: Número de parte de la refacción
 *                     example: "BOS-12345"
 *                   stock_actual:
 *                     type: integer
 *                     description: Cantidad disponible en inventario
 *                     example: 25
 *       400:
 *         description: Parámetro de búsqueda inválido (menos de 2 caracteres)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               example: []
 *       500:
 *         description: Error al buscar refacciones
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Error al buscar refacciones
 */

router.get('/buscar', verifyToken, async (req, res) => {
  const { term } = req.query;

  if (!term || term.length < 2) {
    return res.json([]);
  }

  try {
    const searchTerm = `%${term}%`;
    
    // CAMBIO: Se reescribe la consulta para ser mucho más eficiente
    const result = await pool.query(
      `
      WITH found_refacciones AS (
        -- Paso 1: Encontrar las 10 refacciones que coinciden (esto es muy rápido con los índices)
        SELECT id_refaccion, nombre, marca, numero_parte
        FROM refaccion
        WHERE nombre ILIKE $1 OR marca ILIKE $1 OR numero_parte ILIKE $1
        ORDER BY nombre ASC
        LIMIT 10
      )
      -- Paso 2: Ahora, solo para esas 10 refacciones, calcula su stock
      SELECT 
        fr.id_refaccion,
        (fr.nombre || ' (' || COALESCE(fr.numero_parte, 'S/N') || ')') AS nombre,
        fr.marca,
        fr.numero_parte,
        COALESCE(SUM(l.cantidad_disponible), 0) AS stock_actual
      FROM 
        found_refacciones fr
      LEFT JOIN 
        lote_refaccion l ON fr.id_refaccion = l.id_refaccion
      GROUP BY
        fr.id_refaccion, fr.nombre, fr.marca, fr.numero_parte
      ORDER BY
        fr.nombre ASC;
      `,
      [searchTerm]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error en búsqueda de refacciones:', error);
    res.status(500).json({ message: 'Error al buscar refacciones' });
  }
});


module.exports = router;
