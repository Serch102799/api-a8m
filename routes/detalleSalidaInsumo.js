const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

const { registrarAuditoria } = require('../servicios/auditService');

router.use(verifyToken);

router.post('/', async (req, res) => {
  const { id_salida, id_insumo, cantidad_usada } = req.body;

  // 1. BLINDAJE EXTRA: Verificar que vengan los IDs clave
  if (!id_salida || !id_insumo) {
    return res.status(400).json({ message: 'Faltan datos clave: id_salida o id_insumo son requeridos.' });
  }

  // 2. Verificar que la cantidad sea válida
  if (!cantidad_usada || cantidad_usada <= 0) {
    return res.status(400).json({ message: 'La cantidad debe ser un número positivo mayor a cero.' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Verificar existencia y stock del insumo, bloqueando la fila (FOR UPDATE)
    const insumoResult = await client.query(
      'SELECT stock_actual, costo_unitario_promedio FROM insumo WHERE id_insumo = $1 FOR UPDATE',
      [id_insumo]
    );

    if (insumoResult.rows.length === 0) {
      throw new Error('El insumo especificado no existe en el catálogo.');
    }

    const stockActual = parseFloat(insumoResult.rows[0].stock_actual);
    const costoActual = parseFloat(insumoResult.rows[0].costo_unitario_promedio);

    // Validar si alcanza el stock
    if (stockActual < cantidad_usada) {
      throw new Error(`Stock insuficiente. Disponible: ${stockActual}, Solicitado: ${cantidad_usada}`);
    }

    // Actualizar (descontar) stock
    await client.query(
      'UPDATE insumo SET stock_actual = stock_actual - $1 WHERE id_insumo = $2',
      [cantidad_usada, id_insumo]
    );

    // Insertar detalle en el vale
    const detalleResult = await client.query(
      `INSERT INTO detalle_salida_insumo (id_salida, id_insumo, cantidad_usada, costo_al_momento)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [id_salida, id_insumo, cantidad_usada, costoActual]
    );

    const nuevoDetalleInsumo = detalleResult.rows[0];

    await client.query('COMMIT');

    // 🛡️ REGISTRO DE AUDITORÍA: DESPACHO DE INSUMO
    registrarAuditoria({
        id_usuario: req.user.id, // Obtenido gracias a verifyToken global
        tipo_accion: 'CREAR',
        recurso_afectado: 'detalle_salida_insumo',
        id_recurso_afectado: nuevoDetalleInsumo.id_detalle_salida_insumo,
        detalles_cambio: {
            mensaje: 'Se despachó un insumo del almacén.',
            id_salida_maestra: id_salida,
            id_insumo: id_insumo,
            cantidad_usada: cantidad_usada,
            costo_al_momento: costoActual,
            stock_anterior: stockActual,
            stock_nuevo: stockActual - cantidad_usada
        },
        ip_address: req.ip
    });

    res.status(201).json(nuevoDetalleInsumo);
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en transacción de salida de insumo:', error);
    // Mandamos el mensaje exacto del throw (ej. "Stock insuficiente") al frontend
    res.status(500).json({ message: error.message || 'Error al registrar la salida del insumo' });
  } finally {
    client.release();
  }
});

module.exports = router;