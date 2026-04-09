const express = require('express');
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const router = express.Router();

const { registrarAuditoria } = require('../servicios/auditService');



router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM Detalle_Salida');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener detalles de salida:', error);
    res.status(500).json({ message: 'Error al obtener detalles de salida' });
  }
});

router.get('/salida/:idSalida', verifyToken, async (req, res) => {
  const { idSalida } = req.params;
  try {
    const result = await pool.query(
      `SELECT ds.*, r.nombre as nombre_refaccion, r.marca
       FROM detalle_salida ds
       JOIN refaccion r ON ds.id_refaccion = r.id_refaccion
       WHERE ds.id_salida = $1`, 
      [idSalida]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener detalles por salida:', error);
    res.status(500).json({ message: 'Error al obtener detalles de salida' });
  }
});

// =======================================================
// CREAR DETALLE DE SALIDA (Descontar de Lote)
// =======================================================
router.post('/', verifyToken, async (req, res) => {
  // Se recibe el ID_Lote desde el frontend
  const { ID_Salida, ID_Refaccion, Cantidad_Despachada, ID_Lote } = req.body;
  
  if (!Cantidad_Despachada || Cantidad_Despachada <= 0) {
    return res.status(400).json({ message: 'La cantidad debe ser un número positivo.' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Verificar stock en el lote específico
    const loteResult = await client.query(
      'SELECT cantidad_disponible FROM lote_refaccion WHERE id_lote = $1 FOR UPDATE',
      [ID_Lote]
    );

    if (loteResult.rows.length === 0) {
      throw new Error('El lote seleccionado no existe.');
    }
    
    const stockDisponibleLote = loteResult.rows[0].cantidad_disponible;
    if (stockDisponibleLote < Cantidad_Despachada) {
      throw new Error(`Stock insuficiente en este lote. Disponible: ${stockDisponibleLote}`);
    }

    // 2. Restar stock del lote específico
    await client.query(
      'UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible - $1 WHERE id_lote = $2',
      [Cantidad_Despachada, ID_Lote]
    );
    
    // 3. Insertar el detalle de la salida
    const detalleResult = await client.query(
      `INSERT INTO detalle_salida (id_salida, id_refaccion, cantidad_despachada, id_lote)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [ID_Salida, ID_Refaccion, Cantidad_Despachada, ID_Lote]
    );
    
    const nuevoDetalle = detalleResult.rows[0];

    await client.query('COMMIT');

    // 🛡️ REGISTRO DE AUDITORÍA: DESPACHO DE REFACCIÓN
    registrarAuditoria({
        id_usuario: req.user.id, // Obtenido gracias a verifyToken
        tipo_accion: 'CREAR',
        recurso_afectado: 'detalle_salida',
        id_recurso_afectado: nuevoDetalle.id_detalle_salida,
        detalles_cambio: {
            mensaje: 'Se despachó una refacción del almacén.',
            id_salida_maestra: ID_Salida,
            id_refaccion: ID_Refaccion,
            id_lote: ID_Lote,
            cantidad_despachada: Cantidad_Despachada,
            stock_lote_anterior: stockDisponibleLote,
            stock_lote_nuevo: stockDisponibleLote - Cantidad_Despachada
        },
        ip_address: req.ip
    });

    res.status(201).json({ message: 'Salida de lote registrada', data: nuevoDetalle });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de salida de lote:', error);
    res.status(500).json({ message: error.message || 'Error al procesar la salida' });
  } finally {
    client.release();
  }
});

// =======================================================
// ACTUALIZAR DETALLE DE SALIDA
// =======================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { Cantidad_Despachada } = req.body;
  
  try {
    const result = await pool.query(
      `UPDATE Detalle_Salida
       SET Cantidad_Despachada = $1
       WHERE id_detalle_salida = $2
       RETURNING *`,
      [Cantidad_Despachada, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Detalle de salida no encontrado' });
    }

    // 🛡️ REGISTRO DE AUDITORÍA: EDICIÓN DE DESPACHO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'detalle_salida',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se modificó la cantidad despachada en un vale existente.',
            nueva_cantidad: Cantidad_Despachada
        },
        ip_address: req.ip
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al actualizar detalle de salida:', error);
    res.status(500).json({ message: 'Error al actualizar detalle de salida' });
  }
});

// =======================================================
// ELIMINAR DETALLE DE SALIDA
// =======================================================
router.delete('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  
  try {
    const result = await pool.query(
      'DELETE FROM Detalle_Salida WHERE id_detalle_salida = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Detalle de salida no encontrado' });
    }

    // 🛡️ REGISTRO DE AUDITORÍA: ELIMINACIÓN DE DESPACHO
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ELIMINAR',
        recurso_afectado: 'detalle_salida',
        id_recurso_afectado: id,
        detalles_cambio: {
            mensaje: 'Se eliminó un detalle de salida del vale.',
            datos_eliminados: result.rows[0]
        },
        ip_address: req.ip
    });

    res.json({ message: 'Detalle eliminado exitosamente', detalle: result.rows[0] });
  } catch (error) {
    console.error('Error al eliminar detalle de salida:', error);
    res.status(500).json({ message: 'Error al eliminar detalle de salida' });
  }
});

module.exports = router;