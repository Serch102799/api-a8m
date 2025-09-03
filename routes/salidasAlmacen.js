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
  // CAMBIO: Se recibe 'Fecha_Operacion' del body
  const { 
    Tipo_Salida, 
    ID_Autobus, 
    Solicitado_Por_ID, 
    Observaciones, 
    Kilometraje_Autobus,
    Fecha_Operacion 
  } = req.body;
  
  const client = await pool.connect(); 

  try {
    // CAMBIO: Se añade la validación para evitar fechas futuras
    if (new Date(Fecha_Operacion) > new Date()) {
        return res.status(400).json({ message: 'La fecha de operación no puede ser una fecha futura.' });
    }
    
    // Validación de datos existentes
    if (!Tipo_Salida || !ID_Autobus || !Solicitado_Por_ID || !Fecha_Operacion) {
        return res.status(400).json({ message: 'Faltan datos requeridos (Tipo, Autobús, Solicitado Por y Fecha de Operación).' });
    }

    await client.query('BEGIN');

    const result = await client.query(
      // CAMBIO: Se añade 'fecha_operacion' a la consulta INSERT
      // 'fecha_registro' se llenará automáticamente con la fecha actual por defecto en la BD
      `INSERT INTO salida_almacen (tipo_salida, id_autobus, solicitado_por_id, observaciones, kilometraje_autobus, fecha_operacion)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      // CAMBIO: Se pasa la nueva variable de fecha
      [Tipo_Salida, ID_Autobus, Solicitado_Por_ID, Observaciones, Kilometraje_Autobus, Fecha_Operacion]
    );

    // La lógica para actualizar el kilometraje del autobús se mantiene igual
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

/* router.get('/', async (req, res) => {
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
}); */
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
      SELECT nombre, cantidad, tipo_item FROM (
        SELECT r.nombre, ds.cantidad_despachada as cantidad, 'Refacción' as tipo_item
        FROM detalle_salida ds
        JOIN lote_refaccion l ON ds.id_lote = l.id_lote
        JOIN refaccion r ON l.id_refaccion = r.id_refaccion
        WHERE ds.id_salida = $1

        UNION ALL

        SELECT i.nombre, dsi.cantidad_usada as cantidad, 'Insumo' as tipo_item
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
router.get('/', verifyToken, async (req, res) => {
    const { 
        page = 1, 
        limit = 10, 
        search = '',
        fechaInicio = '',
        fechaFin = '' 
    } = req.query;

    try {
        const params = [];
        let whereClauses = [];
        
        // --- Construcción de Filtros ---
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(a.economico ILIKE $${params.length} OR s.tipo_salida ILIKE $${params.length} OR e.nombre ILIKE $${params.length})`);
        }
        if (fechaInicio) {
            params.push(fechaInicio);
            whereClauses.push(`s.fecha_operacion >= $${params.length}`);
        }
        if (fechaFin) {
            const fechaHasta = new Date(fechaFin);
            fechaHasta.setDate(fechaHasta.getDate() + 1);
            params.push(fechaHasta.toISOString().split('T')[0]);
            whereClauses.push(`s.fecha_operacion < $${params.length}`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // --- Consulta de Conteo Total ---
        const totalQuery = `
            SELECT COUNT(*) 
            FROM salida_almacen s
            LEFT JOIN autobus a ON s.id_autobus = a.id_autobus
            LEFT JOIN empleado e ON s.solicitado_por_id = e.id_empleado
            ${whereString}
        `;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // --- Consulta Principal de Datos ---
        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT
                s.id_salida, s.fecha_operacion, s.tipo_salida, s.observaciones, s.kilometraje_autobus,
                a.economico as economico_autobus,
                e.nombre as nombre_empleado
            FROM
                salida_almacen s
            LEFT JOIN autobus a ON s.id_autobus = a.id_autobus
            LEFT JOIN empleado e ON s.solicitado_por_id = e.id_empleado
            ${whereString}
            ORDER BY s.fecha_operacion DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        
        res.json({
            total: totalItems,
            data: dataResult.rows
        });

    } catch (error) {
        console.error("Error al obtener salidas:", error);
        res.status(500).json({ message: 'Error al obtener salidas' });
    }
});

module.exports = router;
