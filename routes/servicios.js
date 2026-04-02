const express = require('express');
const pool = require('../db');

const router = express.Router();

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
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al agendar:', error);
    res.status(500).json({ message: 'Error al agendar el servicio' });
  }
});

router.post('/:id/completar', async (req, res) => {
  const { id } = req.params;
  const { id_autobus, km_realizado, fecha_realizado, observaciones, id_salida_almacen } = req.body;

  try {
    await pool.query('BEGIN');

    // A) ACTUALIZAMOS EL SERVICIO ACTUAL A 'COMPLETADO'
    await pool.query(`
      UPDATE servicio_preventivo 
      SET estado = 'Completado', fecha_realizado = $1, km_realizado = $2, 
          observaciones = $3, id_salida_almacen = $4
      WHERE id_servicio = $5
    `, [fecha_realizado, km_realizado, observaciones, id_salida_almacen, id]);

    // B) AGENDAMOS EL SIGUIENTE SERVICIO AUTOMÁTICAMENTE
    await pool.query(`
      INSERT INTO servicio_preventivo 
      (id_autobus, fecha_ultimo_servicio, km_ultimo_servicio, fecha_proximo_servicio, km_proximo_servicio)
      VALUES (
        $1, $2, $3, 
        $2::date + INTERVAL '6 months', 
        $3 + 10000
      )
    `, [id_autobus, fecha_realizado, km_realizado]);

    await pool.query('COMMIT'); 
    res.json({ message: 'Servicio completado y próximo servicio agendado correctamente.' });

  } catch (error) {
    await pool.query('ROLLBACK'); 
    console.error('Error al completar servicio:', error);
    res.status(500).json({ message: 'Error al procesar el servicio.' });
  }
});

module.exports = router;