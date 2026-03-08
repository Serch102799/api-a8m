const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);

// 1. CREAR UN NUEVO TICKET (Lo usará el Bot)
router.post('/', async (req, res) => {
  const { asunto, descripcion, modulo_origen } = req.body;
  const id_empleado = req.user.id; // Tomamos el ID del usuario que tiene la sesión iniciada

  try {
    const query = `
      INSERT INTO ticket_soporte (id_empleado, modulo_origen, asunto, descripcion)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const result = await pool.query(query, [id_empleado, modulo_origen, asunto, descripcion]);
    
    res.status(201).json({ message: 'Ticket enviado correctamente', ticket: result.rows[0] });
  } catch (error) {
    console.error('Error al crear ticket:', error);
    res.status(500).json({ message: 'Error en el servidor al enviar el ticket' });
  }
});

// 2. OBTENER TODOS LOS TICKETS (Para tu futura pantalla de Administrador)
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT t.*, e.nombre as empleado
      FROM ticket_soporte t
      JOIN empleado e ON t.id_empleado = e.id_empleado
      ORDER BY t.estatus = 'Pendiente' DESC, t.fecha_creacion DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener tickets:', error);
    res.status(500).json({ message: 'Error al obtener los tickets' });
  }
});
// 3. ACTUALIZAR ESTATUS DEL TICKET
router.put('/:id/estatus', async (req, res) => {
  const { id } = req.params;
  const { estatus } = req.body; // 'Pendiente', 'En Revisión', 'Resuelto'

  try {
    const query = `
      UPDATE ticket_soporte 
      SET estatus = $1 
      WHERE id_ticket = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [estatus, id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Ticket no encontrado' });
    }
    res.json({ message: 'Estatus actualizado', ticket: result.rows[0] });
  } catch (error) {
    console.error('Error al actualizar ticket:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

module.exports = router;