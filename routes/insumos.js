const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

const { registrarAuditoria } = require('../servicios/auditService');

// GET - Obtener todos los insumos (sin cambios en la lógica, ya devuelve costo_unitario_promedio)
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

        const totalQuery = `SELECT COUNT(*) FROM insumo ${whereString}`;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const allowedSortBy = ['nombre', 'marca', 'tipo_insumo', 'stock_actual', 'unidad_medida', 'costo_unitario_promedio'];
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

        res.json({
            total: totalItems,
            data: dataResult.rows
        });

    } catch (error) {
        console.error('Error al obtener insumos:', error);
        res.status(500).json({ message: 'Error al obtener los insumos' });
    }
});

// POST - Crear insumo
router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
  const { nombre, marca, tipo_insumo, unidad_medida, stock_minimo, costo_unitario_promedio } = req.body;
  
  if (!nombre || !unidad_medida || !tipo_insumo) {
    return res.status(400).json({ message: 'Nombre, Unidad de Medida y Tipo son requeridos.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO insumo (nombre, marca, tipo_insumo, unidad_medida, stock_minimo, costo_unitario_promedio) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [nombre, marca, tipo_insumo, unidad_medida, stock_minimo || 0, costo_unitario_promedio || 0]
    );
    const nuevoInsumo = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: CREACIÓN DE INSUMO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'CREAR',
        recurso_afectado: 'insumo',
        id_recurso_afectado: nuevoInsumo.id_insumo,
        detalles_cambio: {
            mensaje: 'Se registró un nuevo insumo en el catálogo.',
            nombre: nuevoInsumo.nombre,
            tipo_insumo: nuevoInsumo.tipo_insumo,
            unidad_medida: nuevoInsumo.unidad_medida
        },
        ip_address: req.ip
    });

    res.status(201).json(nuevoInsumo);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ message: 'El nombre de este insumo ya existe.' });
    }
    console.error('Error al crear el insumo:', error);
    res.status(500).json({ message: 'Error al crear el insumo' });
  }
});

// PUT - Actualizar insumo completo
router.put('/:id', [verifyToken, checkRole(['Admin', 'Almacenista'])], async (req, res) => {
  const { id } = req.params;
  const { nombre, marca, tipo_insumo, unidad_medida, stock_minimo, costo_unitario_promedio } = req.body;

  if (!nombre || !unidad_medida || !tipo_insumo) {
    return res.status(400).json({ message: 'Nombre, Unidad de Medida y Tipo son requeridos.' });
  }

  try {
    const result = await pool.query(
      `UPDATE insumo 
       SET nombre = $1, marca = $2, tipo_insumo = $3, unidad_medida = $4, 
           stock_minimo = $5, costo_unitario_promedio = $6
       WHERE id_insumo = $7 RETURNING *`,
      [nombre, marca, tipo_insumo, unidad_medida, stock_minimo || 0, costo_unitario_promedio || 0, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Insumo no encontrado.' });
    }

    // 🛡️ REGISTRO DE AUDITORÍA: EDICIÓN GENERAL DEL INSUMO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'insumo',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se actualizaron los datos generales del insumo.',
            nuevos_datos: req.body
        },
        ip_address: req.ip
    });

    res.status(200).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(400).json({ message: 'El nombre de este insumo ya existe.' });
    }
    console.error('Error al actualizar el insumo:', error);
    res.status(500).json({ message: 'Error al actualizar el insumo' });
  }
});

// PATCH - Actualizar solo el costo unitario promedio de un insumo (Solo Admin/SuperUsuario)
router.patch('/:id/costo', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
  const { id } = req.params;
  const { costo_unitario_promedio } = req.body;

  if (costo_unitario_promedio === undefined || costo_unitario_promedio === null) {
    return res.status(400).json({ message: 'El costo unitario promedio es requerido.' });
  }

  if (costo_unitario_promedio < 0) {
    return res.status(400).json({ message: 'El costo no puede ser negativo.' });
  }

  const client = await pool.connect();

  try {
    // Obtenemos el costo anterior antes de cambiarlo para dejar el rastro completo
    const costoAnteriorReq = await client.query('SELECT costo_unitario_promedio FROM insumo WHERE id_insumo = $1', [id]);
    
    if (costoAnteriorReq.rows.length === 0) {
        client.release();
        return res.status(404).json({ message: 'Insumo no encontrado.' });
    }
    const costoAnterior = costoAnteriorReq.rows[0].costo_unitario_promedio;

    const result = await client.query(
      `UPDATE insumo 
       SET costo_unitario_promedio = $1 
       WHERE id_insumo = $2 
       RETURNING *`,
      [costo_unitario_promedio, id]
    );

    // 🛡️ REGISTRO DE AUDITORÍA: MODIFICACIÓN DE COSTO PROMEDIO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'insumo',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se ajustó manualmente el costo unitario promedio del insumo.',
            costo_anterior: parseFloat(costoAnterior),
            costo_nuevo: parseFloat(costo_unitario_promedio)
        },
        ip_address: req.ip
    });

    client.release();
    res.status(200).json({
      message: 'Costo actualizado exitosamente',
      insumo: result.rows[0]
    });
  } catch (error) {
    client.release();
    console.error('Error al actualizar el costo:', error);
    res.status(500).json({ message: 'Error al actualizar el costo del insumo' });
  }
});

// DELETE - Eliminar insumo
router.delete('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('DELETE FROM insumo WHERE id_insumo = $1 RETURNING *', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Insumo no encontrado' });
        }

        const insumoEliminado = result.rows[0];

        // 🛡️ REGISTRO DE AUDITORÍA: ELIMINACIÓN
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ELIMINAR',
            recurso_afectado: 'insumo',
            id_recurso_afectado: id,
            detalles_cambio: {
                mensaje: 'Se eliminó el insumo del catálogo.',
                nombre_insumo: insumoEliminado.nombre,
                marca: insumoEliminado.marca
            },
            ip_address: req.ip
        });

        res.json({ message: 'Insumo eliminado' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar insumo. Puede que esté en uso en algún registro.' });
    }
});

// GET - Buscar insumos
router.get('/buscar', verifyToken, async (req, res) => {
  const { term } = req.query;

  if (!term || term.length < 2) {
    return res.json([]);
  }

  try {
    const searchTerm = `%${term}%`;
    const result = await pool.query(
      `SELECT 
          id_insumo,
          (nombre || ' - ' || COALESCE(marca, 'S/M')) AS nombre,
          stock_actual,
          unidad_medida,
          costo_unitario_promedio
      FROM insumo
      WHERE nombre ILIKE $1 OR marca ILIKE $1 OR tipo_insumo::text ILIKE $1
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

// GET - Obtener un insumo por ID
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