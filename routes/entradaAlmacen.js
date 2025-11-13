const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const { registrarAuditoria } = require('../servicios/auditService');
router.use(verifyToken);

/**
 * @swagger
 * tags:
 *   name: EntradasAlmacen
 *   description: Gestión de entradas al almacén
 */

/**
 * @swagger
 * /api/entradas:
 *   get:
 *     summary: Obtener todas las entradas al almacén
 *     tags: [EntradasAlmacen]
 *     responses:
 *       200:
 *         description: Lista de entradas
 */
router.get('/', verifyToken, async (req, res) => {
    const { 
        page = 1, 
        limit = 10, 
        search = '',
        fechaInicio = '',
        fechaFin = '' ,
        sortBy = 'fecha_operacion', 
        sortOrder = 'desc'
    } = req.query;

    try {
        const params = [];
        let whereClauses = [];
        
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(p.nombre_proveedor ILIKE $${params.length} OR ea.factura_proveedor ILIKE $${params.length} OR e.nombre ILIKE $${params.length})`);
        }
        if (fechaInicio) {
            params.push(fechaInicio);
            whereClauses.push(`ea.fecha_operacion >= $${params.length}`);
        }
        if (fechaFin) {
            const fechaHasta = new Date(fechaFin);
            fechaHasta.setDate(fechaHasta.getDate() + 1);
            params.push(fechaHasta.toISOString().split('T')[0]);
            whereClauses.push(`ea.fecha_operacion < $${params.length}`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // --- Consulta de Conteo Total ---
        const totalQuery = `
            SELECT COUNT(*) 
            FROM entrada_almacen ea
            LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
            LEFT JOIN empleado e ON ea.recibido_por_id = e.id_empleado
            ${whereString}
        `;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // --- Consulta Principal de Datos ---
        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT
                ea.*,
                p.nombre_proveedor,
                e.nombre as nombre_empleado,
                COALESCE(entry_totals.valor_neto, 0) AS valor_neto
            FROM
                entrada_almacen ea
            LEFT JOIN proveedor p ON ea.id_proveedor = p.id_proveedor
            LEFT JOIN empleado e ON ea.recibido_por_id = e.id_empleado
            LEFT JOIN (
                SELECT 
                    id_entrada, 
                    SUM(total_linea) as valor_neto 
                FROM (
                    SELECT
                        de.id_entrada,
                        (de.cantidad_recibida * l.costo_unitario_final) as total_linea
                    FROM detalle_entrada de
                    JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
                    UNION ALL
                    SELECT
                        dei.id_entrada,
                        (dei.cantidad_recibida * dei.costo_unitario_final) as total_linea
                    FROM detalle_entrada_insumo dei
                ) as details 
                GROUP BY id_entrada
            ) as entry_totals ON ea.id_entrada = entry_totals.id_entrada
            ${whereString}
            ORDER BY ea.fecha_operacion DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        
        res.json({
            total: totalItems,
            data: dataResult.rows
        });

    } catch (error) {
        // Este log ahora sí se mostrará si hay un error en la consulta
        console.error("Error detallado al obtener entradas:", error);
        res.status(500).json({ message: 'Error al obtener entradas' });
    }
});


// En routes/entradaAlmacen.js

router.get('/detalles/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Consulta para obtener la lista de detalles (la que ya tienes)
    const detallesPromise = pool.query( `
      (SELECT 
        r.nombre AS nombre_item, (r.nombre || ' (' || COALESCE(r.numero_parte, 'S/N') || ')') AS descripcion,
        r.marca, de.cantidad_recibida AS cantidad, l.costo_unitario_final AS costo,
        'Refacción' AS tipo_item
      FROM detalle_entrada de
      JOIN refaccion r ON de.id_refaccion = r.id_refaccion
      JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
      WHERE de.id_entrada = $1)
      UNION ALL
      (SELECT 
        i.nombre AS nombre_item, (i.nombre || ' - ' || COALESCE(i.marca, 'S/M')) AS descripcion,
        i.marca, dei.cantidad_recibida AS cantidad, dei.costo_unitario_final AS costo,
        'Insumo' AS tipo_item
      FROM detalle_entrada_insumo dei
      JOIN insumo i ON dei.id_insumo = i.id_insumo
      WHERE dei.id_entrada = $1)
    `, [id]);

    // Nueva consulta para calcular el valor total de la entrada
    const totalPromise = pool.query(`
      SELECT SUM(valor) as valor_neto FROM (
        SELECT SUM(de.cantidad_recibida * l.costo_unitario_final) as valor
        FROM detalle_entrada de JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
        WHERE de.id_entrada = $1
        UNION ALL
        SELECT SUM(dei.cantidad_recibida * dei.costo_unitario_final) as valor
        FROM detalle_entrada_insumo dei
        WHERE dei.id_entrada = $1
      ) as costos
    `, [id]);
    
    // Ejecutamos ambas consultas en paralelo
    const [detallesResult, totalResult] = await Promise.all([detallesPromise, totalPromise]);

    // Enviamos una respuesta estructurada
    res.json({
      detalles: detallesResult.rows,
      valorNeto: parseFloat(totalResult.rows[0].valor_neto) || 0
    });

  } catch (error) {
    console.error(`Error al obtener detalles de la entrada ${id}:`, error);
    res.status(500).json({ message: 'Error al obtener los detalles de la entrada' });
  }
});


/**
 * @swagger
 * /api/entradas:
 *   post:
 *     summary: Crear una nueva entrada
 *     tags: [EntradasAlmacen]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ID_Proveedor
 *               - Recibido_Por_ID
 *             properties:
 *               ID_Proveedor:
 *                 type: integer
 *               Numero_Factura_Proveedor:
 *                 type: string
 *               Observaciones:
 *                 type: string
 *               Recibido_Por_ID:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Entrada creada
 */
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista','SuperUsuario'])], async (req, res) => {
  // 1. Se recibe 'Fecha_Operacion' del body
  const { 
    ID_Proveedor, 
    Factura_Proveedor, 
    Vale_Interno, 
    Observaciones, 
    Recibido_Por_ID, 
    Razon_Social,
    Fecha_Operacion
  } = req.body;

  if (new Date(Fecha_Operacion) > new Date()) {
        return res.status(400).json({ message: 'La fecha de operación no puede ser una fecha futura.' });
    }
  // 2. Se añade validación para el nuevo campo obligatorio
  if (!Recibido_Por_ID || !Razon_Social || !Fecha_Operacion) {
      return res.status(400).json({ message: 'Recibido Por, Razón Social y Fecha de Operación son requeridos.' });
  }

  try {
    const result = await pool.query(
      // 3. Se corrige la consulta con los 7 campos y placeholders correctos
      //    y se usan nombres de columna en snake_case
      `INSERT INTO entrada_almacen 
        (id_proveedor, factura_proveedor, vale_interno, observaciones, Recibido_Por_ID, razon_social, fecha_operacion) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) 
       RETURNING *`,
      // 4. Se añade 'Fecha_Operacion' al arreglo de parámetros
      [ID_Proveedor, Factura_Proveedor, Vale_Interno, Observaciones, Recibido_Por_ID, Razon_Social, Fecha_Operacion]
    );
    const nuevaEntrada = result.rows[0];
    registrarAuditoria({
      id_usuario: req.user.id,
      tipo_accion: 'CREAR',
      recurso_afectado: 'entrada_almacen',
      id_recurso_afectado: nuevaEntrada.id_entrada,
      detalles_cambio: { 
          factura: Factura_Proveedor, 
          proveedor: ID_Proveedor, 
          razon_social: Razon_Social 
      },
      ip_address: req.ip
    });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al crear entrada:', error);
    res.status(500).json({ message: 'Error al crear la entrada', error: error.message });
  }
});

/**
 * @swagger
 * /api/entradas/proveedor/{id}:
 *   get:
 *     summary: Obtener entradas por ID de proveedor
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Entradas del proveedor
 */
router.get('/proveedor/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM Entrada_Almacen WHERE ID_Proveedor = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar entradas por proveedor', error });
  }
});

/**
 * @swagger
 * /api/entradas/empleado/{id}:
 *   get:
 *     summary: Obtener entradas por ID de empleado que recibió
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Entradas recibidas por el empleado
 */
router.get('/empleado/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT * FROM Entrada_Almacen WHERE Recibido_Por_ID = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar entradas por empleado', error });
  }
});

/**
 * @swagger
 * /api/entradas/{id}:
 *   put:
 *     summary: Actualizar entrada por ID
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               Numero_Factura_Proveedor:
 *                 type: string
 *               Observaciones:
 *                 type: string
 *     responses:
 *       200:
 *         description: Entrada actualizada
 */
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { Numero_Factura_Proveedor, Observaciones } = req.body;

  try {
    const result = await pool.query(
      `UPDATE Entrada_Almacen SET 
        Numero_Factura_Proveedor = $1,
        Observaciones = $2
       WHERE ID_Entrada = $3
       RETURNING *`,
      [Numero_Factura_Proveedor, Observaciones, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entrada no encontrada' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar entrada', error });
  }
});

/**
 * @swagger
 * /api/entradas/{id}:
 *   delete:
 *     summary: Eliminar entrada por ID
 *     tags: [EntradasAlmacen]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema:
 *           type: integer
 *         required: true
 *     responses:
 *       200:
 *         description: Entrada eliminada
 */
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM Entrada_Almacen WHERE ID_Entrada = $1 RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Entrada no encontrada' });
    }

    res.json({ message: 'Entrada eliminada', entrada: result.rows[0] });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar entrada', error });
  }
});

module.exports = router;
