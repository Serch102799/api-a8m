const express = require('express');
const pool = require('../db'); // Ajusta la ruta a tu conexión de BD
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

// Protegemos la ruta
router.use(verifyToken);

// GET: Obtener todos los vehículos particulares activos
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT * FROM vehiculos_particulares 
      WHERE esta_activo = true 
      ORDER BY propietario ASC, marca ASC
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener vehículos particulares:', error);
    res.status(500).json({ message: 'Error del servidor al cargar la flota administrativa.' });
  }
});

// POST: Registrar un nuevo vehículo particular
router.post('/', async (req, res) => {
  const { propietario, puesto, marca, modelo, anio, color, placas, kilometraje_actual } = req.body;

  if (!propietario || !marca || !modelo) {
    return res.status(400).json({ message: 'El propietario, marca y modelo son obligatorios.' });
  }

  try {
    const query = `
      INSERT INTO vehiculos_particulares 
      (propietario, puesto, marca, modelo, anio, color, placas, kilometraje_actual)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `;
    const values = [propietario, puesto, marca, modelo, anio, color, placas, kilometraje_actual || 0];
    
    const result = await pool.query(query, values);
    res.status(201).json({ message: 'Vehículo registrado exitosamente.', vehiculo: result.rows[0] });
  } catch (error) {
    console.error('Error al registrar vehículo particular:', error);
    res.status(500).json({ message: 'Error al registrar el vehículo en el sistema.' });
  }
});

// PUT: Actualizar un vehículo existente
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { propietario, puesto, marca, modelo, anio, color, placas, kilometraje_actual } = req.body;

  try {
    const query = `
      UPDATE vehiculos_particulares 
      SET propietario = $1, puesto = $2, marca = $3, modelo = $4, 
          anio = $5, color = $6, placas = $7, kilometraje_actual = $8
      WHERE id_vehiculo = $9 AND esta_activo = true
      RETURNING *
    `;
    const values = [propietario, puesto, marca, modelo, anio, color, placas, kilometraje_actual, id];
    
    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Vehículo no encontrado o inactivo.' });
    }

    res.json({ message: 'Vehículo actualizado exitosamente.', vehiculo: result.rows[0] });
  } catch (error) {
    console.error('Error al actualizar vehículo:', error);
    res.status(500).json({ message: 'Error al actualizar los datos del vehículo.' });
  }
});

// DELETE: Borrado lógico (desactivar)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      UPDATE vehiculos_particulares 
      SET esta_activo = false 
      WHERE id_vehiculo = $1 
      RETURNING *
    `;
    const result = await pool.query(query, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Vehículo no encontrado.' });
    }

    res.json({ message: 'Vehículo eliminado (dado de baja) del catálogo.' });
  } catch (error) {
    console.error('Error al eliminar vehículo:', error);
    res.status(500).json({ message: 'Error al procesar la baja del vehículo.' });
  }
});

module.exports = router;