const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);

// 1. OBTENER TODOS LOS SERVICIOS EXTERNOS
router.get('/', async (req, res) => {
  try {
    const query = `
      SELECT 
        se.id_servicio,
        se.fecha_servicio,
        se.descripcion,
        se.costo_total,
        se.factura_nota,
        se.estatus,
        se.kilometraje_autobus,
        se.aplica_iva,
        se.subtotal,
        se.iva_monto,
        se.tiene_garantia,
        se.fecha_vencimiento_garantia,
        a.economico as autobus,
        p.nombre_proveedor as proveedor,
        e.nombre as registrado_por
      FROM servicio_externo se
      JOIN autobus a ON se.id_autobus = a.id_autobus
      LEFT JOIN proveedor p ON se.id_proveedor = p.id_proveedor
      JOIN empleado e ON se.registrado_por_id = e.id_empleado
      ORDER BY se.fecha_servicio DESC, se.id_servicio DESC;
    `;
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener servicios externos:', error);
    res.status(500).json({ message: 'Error en el servidor al obtener servicios' });
  }
});

// 2. CREAR UN NUEVO SERVICIO EXTERNO
router.post('/', async (req, res) => {
  // Extraemos todos los campos, incluyendo los nuevos de IVA, Garantía y Km
  const { 
    id_autobus, 
    id_proveedor, 
    fecha_servicio, 
    descripcion, 
    costo_total, 
    factura_nota,
    kilometraje_autobus,
    aplica_iva,
    subtotal,
    iva_monto,
    tiene_garantia,
    fecha_vencimiento_garantia,
    dias_garantia
  } = req.body;
  
  const registrado_por_id = req.user.id; // Obtenido del token

  try {
    const query = `
      INSERT INTO servicio_externo 
        (id_autobus, id_proveedor, fecha_servicio, descripcion, costo_total, factura_nota, registrado_por_id, 
         kilometraje_autobus, aplica_iva, subtotal, iva_monto, tiene_garantia, fecha_vencimiento_garantia, dias_garantia)
      VALUES 
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;
    `;
    
    // Armamos el arreglo asegurándonos de manejar los nulos/falsos correctamente
    const values = [
      id_autobus, 
      id_proveedor || null, 
      fecha_servicio, 
      descripcion, 
      costo_total || 0, 
      factura_nota || null, 
      registrado_por_id,
      kilometraje_autobus || 0,
      aplica_iva || false,
      subtotal || 0,
      iva_monto || 0,
      tiene_garantia || false,
      tiene_garantia ? fecha_vencimiento_garantia : null, // Si no hay garantía, forzamos a nulo
      dias_garantia || 0
    ];
    
    const result = await pool.query(query, values);
    
    // Opcional pero recomendado: Actualizar el kilometraje del autobús en su tabla principal
    if (kilometraje_autobus) {
      await pool.query(
        `UPDATE autobus SET kilometraje_actual = GREATEST(kilometraje_actual, $1) WHERE id_autobus = $2`, 
        [kilometraje_autobus, id_autobus]
      );
    }

    res.status(201).json({ message: 'Servicio externo registrado con éxito', servicio: result.rows[0] });
  } catch (error) {
    console.error('Error al registrar servicio externo:', error);
    res.status(500).json({ message: 'Error al guardar el servicio externo', error: error.message });
  }
});

// 3. CANCELAR UN SERVICIO (Borrado lógico)
router.put('/:id/cancelar', async (req, res) => {
  const { id } = req.params;
  try {
    const query = `UPDATE servicio_externo SET estatus = 'Cancelado' WHERE id_servicio = $1 RETURNING *`;
    const result = await pool.query(query, [id]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Servicio no encontrado' });
    }
    res.json({ message: 'Servicio cancelado correctamente', servicio: result.rows[0] });
  } catch (error) {
    console.error('Error al cancelar servicio:', error);
    res.status(500).json({ message: 'Error en el servidor' });
  }
});

module.exports = router;