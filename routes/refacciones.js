const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();
const { registrarAuditoria } = require('../servicios/auditService');


router.get('/', verifyToken, async (req, res) => {
    const { 
        page = 1, 
        limit = 10, 
        search = '', 
        sortBy = 'nombre', 
        sortOrder = 'asc',
        filtroCategoria = '',
        filtroMarca = ''
    } = req.query;

    try {
        const params = [];
        let whereClauses = [];
        
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(r.nombre ILIKE $${params.length} OR r.numero_parte ILIKE$${params.length})`);
        }
        if (filtroCategoria) {
            params.push(filtroCategoria);
            whereClauses.push(`r.categoria = $${params.length}`);
        }
        if (filtroMarca) {
            params.push(filtroMarca);
            whereClauses.push(`r.marca =$${params.length}`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        const totalQuery = `SELECT COUNT(*) FROM refaccion r ${whereString}`;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const allowedSortBy = ['nombre', 'marca', 'stock_actual', 'ultimo_costo'];
        const sortColumn = allowedSortBy.includes(sortBy) ? sortBy : 'nombre';
        const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        const offset = (page - 1) * limit;

        const dataQuery = `
    SELECT 
        r.*,
        
        -- 1. Calcular el Stock Actual sumando lo disponible en todos los lotes
        COALESCE(
            (SELECT SUM(l.cantidad_disponible) 
             FROM lote_refaccion l 
             WHERE l.id_refaccion = r.id_refaccion), 
        0) as stock_actual,

        -- 2. Obtener el Último Costo (El precio del lote más reciente)
        COALESCE(
            (SELECT l.costo_unitario_final 
             FROM lote_refaccion l 
             WHERE l.id_refaccion = r.id_refaccion 
             ORDER BY l.fecha_ingreso DESC, l.id_lote DESC 
             LIMIT 1), 
        0) as ultimo_costo,

        -- 3. Calcular el Precio Unitario (Costo Promedio Ponderado)
        COALESCE(
            (SELECT SUM(l.cantidad_disponible * l.costo_unitario_final) / NULLIF(SUM(l.cantidad_disponible), 0) 
             FROM lote_refaccion l 
             WHERE l.id_refaccion = r.id_refaccion AND l.cantidad_disponible > 0), 
        0) as precio_costo

    FROM refaccion r
    ORDER BY r.nombre ASC
    LIMIT $1 OFFSET $2;
`;
        
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        
        res.json({
            total: totalItems,
            data: dataResult.rows
        });

    } catch (error) {
        console.error("Error al obtener refacciones:", error);
        res.status(500).json({ message: 'Error al obtener refacciones' });
    }
});

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

router.get('/categoria/:categoria', async (req, res) => {
  try {
    const { categoria } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Categoria) = LOWER($1)', [categoria]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones por categoría' });
  }
});

router.get('/marca/:marca', async (req, res) => {
  try {
    const { marca } = req.params;
    const result = await pool.query('SELECT * FROM Refaccion WHERE LOWER(Marca) = LOWER($1)', [marca]);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener refacciones por marca' });
  }
});

// =======================================================
// FUSIONAR REFACCIONES
// =======================================================
router.post('/fusionar', verifyToken, async (req, res) => {
    const { id_principal, id_duplicado } = req.body;

    if (!id_principal || !id_duplicado || id_principal === id_duplicado) {
        return res.status(400).json({ message: 'IDs inválidos para la fusión.' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query('UPDATE lote_refaccion SET id_refaccion = $1 WHERE id_refaccion = $2', [id_principal, id_duplicado]);
        await client.query('UPDATE detalle_entrada SET id_refaccion = $1 WHERE id_refaccion = $2', [id_principal, id_duplicado]);
        await client.query('UPDATE detalle_salida SET id_refaccion = $1 WHERE id_refaccion = $2', [id_principal, id_duplicado]);
        await client.query('DELETE FROM refaccion WHERE id_refaccion = $1', [id_duplicado]);

        await client.query('COMMIT');

        // 🛡️ REGISTRO DE AUDITORÍA: FUSIÓN DE ARTÍCULOS
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'refaccion',
            id_recurso_afectado: id_principal,
            detalles_cambio: {
                mensaje: 'Se fusionaron dos artículos. Se trasladó el historial y se eliminó el duplicado.',
                id_duplicado_eliminado: id_duplicado
            },
            ip_address: req.ip
        });

        res.status(200).json({ message: 'Fusión completada con éxito. El historial se ha unificado.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en la fusión:', error);
        res.status(500).json({ message: 'Error interno al fusionar los artículos.', error: error.message });
    } finally {
        client.release();
    }
});

// =======================================================
// CREAR NUEVA REFACCIÓN
// =======================================================
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista', 'SuperUsuario'])], async (req, res) => {
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

    const nuevaRefaccion = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: CREAR REFACCIÓN
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'CREAR',
        recurso_afectado: 'refaccion',
        id_recurso_afectado: nuevaRefaccion.id_refaccion,
        detalles_cambio: {
            nombre: nuevaRefaccion.nombre,
            numero_parte: nuevaRefaccion.numero_parte,
            marca: nuevaRefaccion.marca
        },
        ip_address: req.ip
    });

    res.status(201).json(nuevaRefaccion);
  } catch (error) {
    if (error.code === '23505') { 
      return res.status(400).json({ message: 'Una refacción con ese nombre o número de parte ya existe.' });
    }
    console.error('Error al crear refacción:', error);
    res.status(500).json({ message: 'Error al crear la refacción' });
  }
});

// =======================================================
// ACTUALIZAR REFACCIÓN
// =======================================================
router.put('/:id', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
  const { id } = req.params;
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
         stock_maximo = $9 
       WHERE id_refaccion = $10 
       RETURNING *`,
      [
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

    const refaccionActualizada = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: ACTUALIZAR REFACCIÓN
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'refaccion',
        id_recurso_afectado: id,
        detalles_cambio: req.body, // Se guarda el payload con los nuevos datos
        ip_address: req.ip
    });

    res.status(200).json(refaccionActualizada);
  } catch (error) {
    console.error('Error al actualizar la refacción:', error);
    res.status(500).json({ message: 'Error al actualizar la refacción' });
  }
});

// =======================================================
// ELIMINAR REFACCIÓN (CON BORRADO EN CASCADA SEGURO)
// =======================================================
router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    const client = await pool.connect();

    try {
        await client.query('BEGIN'); // Iniciamos transacción segura

        // 1. Borrar de las salidas (si alguien sacó piezas de este lote)
        await client.query(`
            DELETE FROM detalle_salida 
            WHERE id_lote IN (SELECT id_lote FROM lote_refaccion WHERE id_refaccion = $1)
        `, [id]);

        // 2. Borrar de las entradas (si hubo historial de compras)
        await client.query('DELETE FROM detalle_entrada WHERE id_refaccion = $1', [id]);

        // 3. Borrar el stock (Lotes)
        await client.query('DELETE FROM lote_refaccion WHERE id_refaccion = $1', [id]);

        // 4. Finalmente, borrar del catálogo de refacciones
        const result = await client.query('DELETE FROM refaccion WHERE id_refaccion = $1 RETURNING *', [id]);

        if (result.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Refacción no encontrada.' });
        }

        await client.query('COMMIT'); // Guardamos los cambios

        // 🛡️ REGISTRO DE AUDITORÍA: ELIMINAR REFACCIÓN Y SU HISTORIAL
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ELIMINAR',
            recurso_afectado: 'refaccion',
            id_recurso_afectado: id,
            detalles_cambio: {
                mensaje: 'Se eliminó la refacción y todo su historial de entradas/salidas en cascada.',
                nombre_refaccion: result.rows[0].nombre,
                numero_parte: result.rows[0].numero_parte
            },
            ip_address: req.ip
        });

        res.status(200).json({ message: 'Refacción y todo su historial eliminados correctamente.' });

    } catch (error) {
        await client.query('ROLLBACK'); // Si algo falla, cancelamos todo para no romper la BD
        console.error('Error al eliminar refacción:', error);
        res.status(500).json({ message: 'Error interno al eliminar la refacción.', error: error.message });
    } finally {
        client.release();
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
      WITH found_refacciones AS (
        SELECT id_refaccion, nombre, marca, numero_parte
        FROM refaccion
        WHERE nombre ILIKE $1 OR marca ILIKE $1 OR numero_parte ILIKE $1
        ORDER BY nombre ASC
        LIMIT 10
      )
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