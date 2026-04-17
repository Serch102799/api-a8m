const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const router = express.Router();

const { registrarAuditoria } = require('../servicios/auditService');

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
router.get('/modelos', verifyToken, async (req, res) => {
    try {
        const result = await pool.query('SELECT DISTINCT modelo FROM autobus WHERE modelo IS NOT NULL ORDER BY modelo');
        res.json(result.rows.map(row => row.modelo));
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener modelos de autobús' });
    }
});

router.get('/', async (req, res) => {
  const { 
    page = 1, 
    limit = 10, 
    search = '',
    sortBy = 'economico', 
    sortOrder = 'asc'  
  } = req.query;
  
  try {
    const allowedSortBy = ['economico', 'marca', 'modelo', 'anio', 'kilometraje_actual', 'placa', 'razon_social'];
    const sortColumn = allowedSortBy.includes(sortBy) ? sortBy : 'economico';
    const sortDirection = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const params = [];
    let whereClause = '';

    if (search.trim() !== '') {
      const searchTerm = `%${search.trim()}%`;
      params.push(searchTerm);
      whereClause = `
        WHERE (
          economico ILIKE $1 OR marca ILIKE $1 OR vin ILIKE $1 OR 
          placa ILIKE $1 OR razon_social::text ILIKE $1 OR chasis ILIKE $1
        )
      `;
    }

    const totalQuery = `SELECT COUNT(*) FROM autobus ${whereClause}`;
    const totalResult = await pool.query(totalQuery, params);
    const totalItems = parseInt(totalResult.rows[0].count, 10);

    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];
    
    const orderByClause = `ORDER BY ${sortColumn} ${sortDirection}`;
    const limitOffsetPlaceholders = `LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

    const dataQuery = `SELECT * FROM autobus ${whereClause} ${orderByClause} ${limitOffsetPlaceholders}`;
    
    const dataResult = await pool.query(dataQuery, dataParams);

    res.json({
      total: totalItems,
      data: dataResult.rows
    });

  } catch (error) {
    console.error("Error al obtener autobuses:", error);
    res.status(500).json({ message: 'Error al obtener autobuses' });
  }
});

router.get('/lista-simple', verifyToken, async (req, res) => {
  try {
    // 🛠️ SE AGREGÓ "modelo"
    const result = await pool.query(
      'SELECT id_autobus, economico, modelo, kilometraje_actual FROM autobus ORDER BY economico ASC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener la lista simple de autobuses:', error);
    res.status(500).json({ message: 'Error al obtener la lista de autobuses' });
  }
});

router.get('/buscar', verifyToken, async (req, res) => {
  const { term } = req.query;

  if (!term || term.length < 1) {
    return res.json([]);
  }

  try {
    const searchTerm = `%${term}%`;
    // 🛠️ SE AGREGÓ "modelo" A LA CONSULTA PARA QUE EL KPI DE DIÉSEL LO PUEDA USAR
    const result = await pool.query(
      `SELECT id_autobus, economico, modelo, kilometraje_actual, kilometraje_ultima_carga  
       FROM autobus 
       WHERE economico ILIKE $1 OR marca ILIKE $1 OR placa ILIKE $1 OR vin ILIKE $1
       ORDER BY economico ASC
       LIMIT 10`, 
      [searchTerm]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error en búsqueda de autobuses:', error);
    res.status(500).json({ message: 'Error al buscar autobuses' });
  }
});

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

// =======================================================
// CREAR AUTOBÚS
// =======================================================
router.post('/', [verifyToken, checkRole(['Admin','SuperUsuario'])], validateAutobus, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errores: errors.array() });
  }

  const { 
    Economico, Marca, Modelo, Anio, Kilometraje_Actual, VIN, Razon_Social,
    Chasis, Motor, Tarjeta_Circulacion, Placa, Sistema,HP, Carroceria, Sistema_Electrico, Medida_Llanta 
  } = req.body;

  try {
    const result = await pool.query(
      `INSERT INTO autobus (
        economico, marca, modelo, anio, kilometraje_actual, vin, razon_social, 
        chasis, motor, tarjeta_circulacion, placa, sistema,HP, Carroceria, Sistema_Electrico, Medida_Llanta
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        Economico, Marca, Modelo, Anio, Kilometraje_Actual, VIN, Razon_Social,
        Chasis, Motor, Tarjeta_Circulacion, Placa, Sistema, HP, Carroceria, Sistema_Electrico, Medida_Llanta
      ]
    );

    const nuevoAutobus = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: CREACIÓN
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'CREAR',
        recurso_afectado: 'autobus',
        id_recurso_afectado: nuevoAutobus.id_autobus,
        detalles_cambio: {
            mensaje: 'Se registró un nuevo autobús en la flota.',
            economico: nuevoAutobus.economico,
            vin: nuevoAutobus.vin,
            razon_social: nuevoAutobus.razon_social
        },
        ip_address: req.ip
    });

    res.status(201).json(nuevoAutobus);
  } catch (error) {
    if (error.code === '23505') {
        let message = 'Uno de los identificadores únicos ya está en uso (Económico, VIN, Chasis o Motor).';
        if (error.constraint && error.constraint.includes('economico')) message = 'El número económico ya está en uso.';
        if (error.constraint && error.constraint.includes('vin')) message = 'El VIN ya está en uso.';
        return res.status(400).json({ message });
    }
    if (error.code === '23503' || error.code === '22P02') { 
        let message = 'Uno de los valores seleccionados no es válido (Razón Social o Sistema).';
        return res.status(400).json({ message });
    }
    console.error("Error al crear el autobús:", error);
    res.status(500).json({ message: 'Error interno al crear el autobús' });
  }
});

// =======================================================
// ACTUALIZAR AUTOBÚS
// =======================================================
router.put('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
  const { id } = req.params; 
  const { 
    Marca, Modelo, Anio, Kilometraje_Actual, Razon_Social,
    Chasis, Motor, Tarjeta_Circulacion, Placa, Sistema, HP, Carroceria, Sistema_Electrico, Medida_Llanta
  } = req.body; 

  try {
    const result = await pool.query(
      `UPDATE Autobus 
       SET 
          Marca = $1, Modelo = $2, Anio = $3, Kilometraje_Actual = $4,
         razon_social = $5, chasis = $6, motor = $7, tarjeta_circulacion = $8,
         placa = $9, sistema = $10, hp = $11, carroceria = $12,
         sistema_electrico = $13, medida_llanta = $14
       WHERE ID_Autobus = $15
       RETURNING *`,
      [
        Marca, Modelo, Anio, Kilometraje_Actual, Razon_Social,
        Chasis, Motor, Tarjeta_Circulacion, Placa, Sistema, HP, Carroceria, Sistema_Electrico, Medida_Llanta,
        id 
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }

    // 🛡️ REGISTRO DE AUDITORÍA: ACTUALIZACIÓN
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'autobus',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se actualizaron los datos técnicos o administrativos del autobús.',
            nuevos_datos: req.body // Guarda exactamente lo que se mandó
        },
        ip_address: req.ip
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error al actualizar autobús:", error);
    if (error.code === '23505') {
        return res.status(400).json({ message: 'Uno de los identificadores únicos (VIN, Chasis, Placa, etc.) ya está en uso.' });
    }
    if (error.code === '23503' || error.code === '22P02') { 
        return res.status(400).json({ message: 'Uno de los valores seleccionados (Razón Social o Sistema) no es válido.' });
    }
    res.status(500).json({ message: 'Error al actualizar el autobús' });
  }
});

// =======================================================
// ELIMINAR AUTOBÚS
// =======================================================
router.delete('/:id', [verifyToken, checkRole(['Admin'])], async (req, res) => {
  const { id } = req.params; 

  try {
    const result = await pool.query(
      'DELETE FROM Autobus WHERE ID_Autobus = $1 RETURNING *',
      [id] 
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Autobús no encontrado' });
    }

    const busEliminado = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: ELIMINACIÓN
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ELIMINAR',
        recurso_afectado: 'autobus',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se eliminó un autobús permanentemente del sistema.',
            economico: busEliminado.economico,
            vin: busEliminado.vin
        },
        ip_address: req.ip
    });

    res.json({ message: 'Autobús eliminado exitosamente', autobus: busEliminado });
  } catch (error) {
    console.error("Error al eliminar autobús:", error);
    if (error.code === '23503') {
      return res.status(400).json({ message: 'No se puede eliminar el autobús porque tiene historial de mantenimiento asociado.' });
    }
    res.status(500).json({ message: 'Error al eliminar el autobús' });
  }
});

// GET detalles de entrada (Lo dejé tal como estaba en tu código original)
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

// =======================================================
// SINCRONIZAR KILOMETRAJE MANUALMENTE (Crítico para auditoría)
// =======================================================
router.post('/:id/sync-km-carga', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { kilometraje } = req.body;

    if (kilometraje === undefined || kilometraje < 0) {
        return res.status(400).json({ message: 'Se requiere un valor de kilometraje válido.' });
    }

    try {
        const result = await pool.query(
            'UPDATE autobus SET kilometraje_ultima_carga = $1 WHERE id_autobus = $2 RETURNING *',
            [kilometraje, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Autobús no encontrado.' });
        }

        // 🛡️ REGISTRO DE AUDITORÍA: AJUSTE DE KILOMETRAJE MANUAL
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'autobus',
            id_recurso_afectado: id,
            detalles_cambio: {
                mensaje: 'Se forzó la sincronización/ajuste manual del kilometraje de última carga.',
                nuevo_kilometraje_carga: kilometraje
            },
            ip_address: req.ip
        });

        res.status(200).json({ message: 'Kilometraje de última carga actualizado exitosamente.' });

    } catch (error) {
        console.error('Error al sincronizar kilometraje de carga:', error);
        res.status(500).json({ message: 'Error en el servidor.' });
    }
});

module.exports = router;