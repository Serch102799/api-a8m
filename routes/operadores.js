const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
/**
 * @swagger
 * tags:
 *   - name: Operadores
 *     description: Gestión del catálogo de operadores (chóferes)
 */
router.get('/buscar', verifyToken, async (req, res) => {
    const { term } = req.query;
    if (!term || term.length < 1) { return res.json([]); }
    try {
        const searchTerm = `%${term}%`;
        const result = await pool.query(
            `SELECT id_operador, nombre_completo 
             FROM operadores 
             WHERE nombre_completo ILIKE $1 AND esta_activo = true
             ORDER BY nombre_completo ASC LIMIT 10`,
            [searchTerm]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al buscar operadores' });
    }
});
/**
 * @swagger
 * /operadores:
 *   get:
 *     summary: Obtener lista paginada de operadores con cálculos de edad y antigüedad
 *     tags: [Operadores]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Número de página
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Cantidad de elementos por página
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Texto para filtrar por nombre, número de empleado o NSS
 *     responses:
 *       200:
 *         description: Lista de operadores
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total:
 *                   type: integer
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Operador'
 *       500:
 *         description: Error interno del servidor
 * 
 *   post:
 *     summary: Crear un nuevo operador
 *     tags: [Operadores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OperadorInput'
 *     responses:
 *       201:
 *         description: Operador creado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Operador'
 *       400:
 *         description: Datos inválidos o duplicados
 *       500:
 *         description: Error interno del servidor
 */
router.get('/', verifyToken, async (req, res) => {
    // Agregamos 'estado' con valor por defecto 'activos'
    const { page = 1, limit = 10, search = '', estado = 'activos' } = req.query;
    
    try {
        const params = [];
        const whereConditions = []; // Usamos un array para construir la consulta

        // 1. Filtro de Búsqueda
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereConditions.push(`(nombre_completo ILIKE $${params.length} OR numero_empleado ILIKE $${params.length} OR nss ILIKE $${params.length})`);
        }

        // 2. Filtro de Estado (¡NUEVO!)
        if (estado === 'activos') {
            whereConditions.push('esta_activo = true');
        } else if (estado === 'inactivos') {
            whereConditions.push('esta_activo = false');
        }
        // Si estado es 'todos', no agregamos ninguna condición de estado

        // Construimos el WHERE clause
        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        // Query de conteo total
        const totalResult = await pool.query(`SELECT COUNT(*) FROM operadores ${whereClause}`, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // Query de datos paginados
        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT 
                id_operador,
                nombre_completo,
                numero_licencia,
                tipo_licencia,
                licencia_vencimiento,
                numero_empleado,
                estatus,
                nss,
                estatus_nss,
                fecha_nacimiento,
                fecha_ingreso,
                -- Nuevos campos de estado
                esta_activo,
                fecha_baja,
                motivo_baja,
                -- Cálculos
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, fecha_nacimiento)) AS edad,
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, fecha_ingreso)) AS antiguedad_anios
            FROM operadores
            ${whereClause}
            ORDER BY nombre_completo ASC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        
        res.json({ total: totalItems, data: dataResult.rows });
    } catch (error) {
        console.error('Error al obtener operadores:', error);
        res.status(500).json({ message: 'Error al obtener operadores' });
    }
});
/**
 * @swagger
 * /operadores:
 *   post:
 *     summary: Crear un nuevo operador
 *     tags: [Operadores]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OperadorInput'
 *     responses:
 *       201:
 *         description: Operador creado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Operador'
 *       400:
 *         description: Datos inválidos o duplicados
 *       500:
 *         description: Error interno del servidor
 */
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { 
        nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
        numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss 
    } = req.body;

    if (!nombre_completo) {
        return res.status(400).json({ message: 'El nombre completo es requerido.' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO operadores (
                nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
                numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
                numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ message: 'El número de licencia, de empleado o NSS ya existe.' });
        }
        console.error('Error al crear el operador:', error);
        res.status(500).json({ message: 'Error al crear el operador' });
    }
});

/**
 * @swagger
 * /operadores/{id}:
 *   put:
 *     summary: Actualizar un operador existente
 *     tags: [Operadores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del operador a actualizar
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/OperadorInput'
 *     responses:
 *       200:
 *         description: Operador actualizado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Operador'
 *       400:
 *         description: Datos inválidos o duplicados
 *       404:
 *         description: Operador no encontrado
 *       500:
 *         description: Error interno del servidor
 * 
 *   delete:
 *     summary: Desactivar un operador (Soft Delete)
 *     tags: [Operadores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del operador a desactivar
 *     responses:
 *       200:
 *         description: Operador desactivado exitosamente
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       404:
 *         description: Operador no encontrado
 *       500:
 *         description: Error interno del servidor
 */
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    // Quitamos 'estatus' del body, ya no se gestiona aquí
    const { 
        nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
        numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss 
    } = req.body;
    
    if (!nombre_completo) {
        return res.status(400).json({ message: 'El nombre completo es requerido.' });
    }

    try {
        // Actualizamos la consulta y los parámetros para quitar 'estatus'
        const result = await pool.query(
            `UPDATE operadores SET
                nombre_completo = $1, numero_licencia = $2, tipo_licencia = $3, 
                licencia_vencimiento = $4, numero_empleado = $5,
                fecha_nacimiento = $6, fecha_ingreso = $7, nss = $8, estatus_nss = $9
             WHERE id_operador = $10 RETURNING *`,
            [
                nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento,
                numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss,
                id
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Operador no encontrado.' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ message: 'El número de licencia, de empleado o NSS ya está en uso por otro operador.' });
        }
        console.error('Error al actualizar el operador:', error);
        res.status(500).json({ message: 'Error al actualizar el operador' });
    }
});
/**
 * @swagger
 * /operadores/{id}:
 *   delete:
 *     summary: Desactivar un operador (Soft Delete)
 *     tags: [Operadores]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID del operador a desactivar
 *     responses:
 *       200:
 *         description: Operador desactivado exitosamente
 *       404:
 *         description: Operador no encontrado
 *       500:
 *         description: Error interno del servidor
 */
router.patch('/:id/desactivar', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { fecha_baja, motivo_baja } = req.body;

    if (!fecha_baja || !motivo_baja) {
        return res.status(400).json({ message: 'La fecha y el motivo de la baja son requeridos.' });
    }

    try {
        const result = await pool.query(
            `UPDATE operadores 
             SET esta_activo = false, fecha_baja = $1, motivo_baja = $2 
             WHERE id_operador = $3 RETURNING *`,
            [fecha_baja, motivo_baja, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Operador no encontrado.' });
        }
        res.json({ message: 'Operador desactivado exitosamente.', operador: result.rows[0] });
    } catch (error) {
        console.error('Error al desactivar el operador:', error);
        res.status(500).json({ message: 'Error al desactivar el operador' });
    }
});
router.patch('/:id/reactivar', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE operadores 
             SET esta_activo = true, fecha_baja = NULL, motivo_baja = NULL 
             WHERE id_operador = $1 RETURNING *`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Operador no encontrado.' });
        }
        res.json({ message: 'Operador reactivado exitosamente.', operador: result.rows[0] });
    } catch (error) {
        console.error('Error al reactivar el operador:', error);
        res.status(500).json({ message: 'Error al reactivar el operador' });
    }
});


module.exports = router;