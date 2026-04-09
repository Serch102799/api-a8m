const express = require('express');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');

const { registrarAuditoria } = require('../servicios/auditService');

const router = express.Router();

// Protegemos todas las rutas de este archivo para poder saber quién hace los cambios
router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        sp.*, 
        a.economico, 
        a.kilometraje_ultima_carga as km_actual_bus
      FROM servicio_preventivo sp
      JOIN autobus a ON sp.id_autobus = a.id_autobus
      ORDER BY sp.fecha_proximo_servicio ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener servicios:', error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

router.get('/kpi-pendientes', async (req, res) => {
  try {
     const result = await pool.query(`
      SELECT COUNT(*) as total_pendientes
      FROM servicio_preventivo sp
      JOIN autobus a ON sp.id_autobus = a.id_autobus
      WHERE sp.estado = 'Pendiente'
      AND (
        sp.fecha_proximo_servicio <= CURRENT_DATE + INTERVAL '30 days'
        OR a.kilometraje_ultima_carga >= (sp.km_proximo_servicio - 500) -- Avisa 500km antes
      )
    `);
    res.json({ pendientes: parseInt(result.rows[0].total_pendientes) });
  } catch (error) {
    res.status(500).json({ message: 'Error al calcular KPI de servicios' });
  }
});

// =======================================================
// CREAR/AGENDAR UN NUEVO SERVICIO PREVENTIVO
// =======================================================
router.post('/', async (req, res) => {
  const { id_autobus, fecha_ultimo_servicio, km_ultimo_servicio, observaciones } = req.body;

  try {
    const result = await pool.query(`
      INSERT INTO servicio_preventivo 
      (id_autobus, fecha_ultimo_servicio, km_ultimo_servicio, fecha_proximo_servicio, km_proximo_servicio, observaciones)
      VALUES (
        $1, $2, $3, 
        $2::date + INTERVAL '6 months', -- Calcula 6 meses automáticos
        $3 + 10000,                     -- Calcula 10,000 km automáticos
        $4
      ) RETURNING *
    `, [id_autobus, fecha_ultimo_servicio, km_ultimo_servicio, observaciones]);
    
    const nuevoServicio = result.rows[0];

    // 🛡️ REGISTRO DE AUDITORÍA: AGENDAR SERVICIO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'CREAR',
        recurso_afectado: 'servicio_preventivo',
        id_recurso_afectado: nuevoServicio.id_servicio,
        detalles_cambio: {
            mensaje: 'Se agendó un servicio preventivo manual.',
            id_autobus: id_autobus,
            fecha_programada: nuevoServicio.fecha_proximo_servicio,
            km_programado: nuevoServicio.km_proximo_servicio
        },
        ip_address: req.ip
    });

    res.status(201).json(nuevoServicio);
  } catch (error) {
    console.error('Error al agendar:', error);
    res.status(500).json({ message: 'Error al agendar el servicio' });
  }
});

// =======================================================
// COMPLETAR SERVICIO Y AUTO-AGENDAR EL SIGUIENTE
// =======================================================
router.post('/:id/completar', async (req, res) => {
  const { id } = req.params;
  const { id_autobus, km_realizado, fecha_realizado, observaciones, id_salida_almacen } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // A) ACTUALIZAMOS EL SERVICIO ACTUAL A 'COMPLETADO'
    await client.query(`
      UPDATE servicio_preventivo 
      SET estado = 'Completado', fecha_realizado = $1, km_realizado = $2, 
          observaciones = $3, id_salida_almacen = $4
      WHERE id_servicio = $5
    `, [fecha_realizado, km_realizado, observaciones, id_salida_almacen || null, id]);

    // B) AGENDAMOS EL SIGUIENTE SERVICIO AUTOMÁTICAMENTE
    const nuevoServicioReq = await client.query(`
      INSERT INTO servicio_preventivo 
      (id_autobus, fecha_ultimo_servicio, km_ultimo_servicio, fecha_proximo_servicio, km_proximo_servicio)
      VALUES (
        $1, $2, $3, 
        $2::date + INTERVAL '6 months', 
        $3 + 10000
      ) RETURNING id_servicio
    `, [id_autobus, fecha_realizado, km_realizado]);

    await client.query('COMMIT'); 

    // 🛡️ REGISTRO DE AUDITORÍA: COMPLETAR SERVICIO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'servicio_preventivo',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se marcó un servicio preventivo como COMPLETADO y se auto-agendó el siguiente.',
            km_realizado: km_realizado,
            fecha_realizado: fecha_realizado,
            id_salida_almacen: id_salida_almacen || 'Sin vale de almacén vinculado',
            id_nuevo_servicio_agendado: nuevoServicioReq.rows[0].id_servicio
        },
        ip_address: req.ip
    });

    res.json({ message: 'Servicio completado y próximo servicio agendado correctamente.' });

  } catch (error) {
    await client.query('ROLLBACK'); 
    console.error('Error al completar servicio:', error);
    res.status(500).json({ message: 'Error al procesar el servicio.' });
  } finally {
    client.release();
  }
});

module.exports = router;