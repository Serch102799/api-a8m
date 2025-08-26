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
router.get('/', async (req, res) => {
    const { 
        page = 1, 
        limit = 10, 
        search = '', 
        tipo = '',
        sortBy = 'nombre',
        sortOrder = 'asc'
    } = req.query;

    try {
        // --- Construcción de la Consulta ---
        const params = [];
        let whereClauses = [];

        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(nombre ILIKE $${params.length} OR marca ILIKE $${params.length})`);
        }

        if (tipo.trim()) {
            params.push(tipo.trim());
            whereClauses.push(`tipo_insumo = $${params.length}`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // --- Consulta de Conteo Total ---
        const totalQuery = `SELECT COUNT(*) FROM insumo ${whereString}`;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // --- Consulta de Datos Paginados ---
        const allowedSortBy = ['nombre', 'marca', 'tipo_insumo', 'stock_actual', 'unidad_medida'];
        const sortColumn = allowedSortBy.includes(sortBy) ? sortBy : 'nombre';
        const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT * FROM insumo 
            ${whereString} 
            ORDER BY ${sortColumn} ${sortDirection} 
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

        // --- Envío de Respuesta Estructurada ---
        res.json({
            total: totalItems,
            data: dataResult.rows
        });

    } catch (error) {
        console.error('Error al obtener insumos:', error);
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
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
  // CAMBIO: Se usan los nombres de propiedad correctos que envía el frontend
  const { nombre, marca, tipo_insumo, unidad_medida, stock_minimo } = req.body;
  
  if (!nombre || !unidad_medida || !tipo_insumo) {
    return res.status(400).json({ message: 'Nombre, Unidad de Medida y Tipo son requeridos.' });
  }

  try {
    const result = await pool.query(
      // CAMBIO: La consulta ahora usa la columna 'tipo_insumo'
      `INSERT INTO insumo (nombre, marca, tipo_insumo, unidad_medida, stock_minimo) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nombre, marca, tipo_insumo, unidad_medida, stock_minimo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ message: 'El nombre de este insumo ya existe.' });
    }
    console.error('Error al crear el insumo:', error);
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
router.put('/:id', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
  const { id } = req.params;
  const { nombre, marca, tipo_insumo, unidad_medida, stock_minimo } = req.body;

  if (!nombre || !unidad_medida || !tipo_insumo) {
    return res.status(400).json({ message: 'Nombre, Unidad de Medida y Tipo son requeridos.' });
  }

  try {
    const result = await pool.query(
      `UPDATE insumo 
       SET nombre = $1, marca = $2, tipo_insumo = $3, unidad_medida = $4, stock_minimo = $5 
       WHERE id_insumo = $6 RETURNING *`,
      [nombre, marca, tipo_insumo, unidad_medida, stock_minimo, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Insumo no encontrado.' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ message: 'El nombre de este insumo ya existe.' });
    }
    console.error('Error al actualizar el insumo:', error);
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
      `
      SELECT 
          id_insumo,
          (nombre || ' - ' || COALESCE(marca, 'S/M')) AS nombre,
          stock_actual,
          unidad_medida
      FROM 
          insumo
      WHERE 
          -- CAMBIO: Se usa la columna correcta 'tipo_insumo' en lugar de 'tipo'
          nombre ILIKE $1 OR marca ILIKE $1 OR tipo_insumo::text ILIKE $1
      ORDER BY 
          nombre ASC
      LIMIT 10
      `,
      [searchTerm]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en búsqueda de insumos:', error);
    res.status(500).json({ message: 'Error al buscar insumos' });
  }
});
router.get('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM insumo WHERE id_insumo = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Insumo no encontrado' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error(`Error al obtener el insumo ${id}:`, error);
    res.status(500).json({ message: 'Error al obtener el insumo' });
  }
});
module.exports = router;
