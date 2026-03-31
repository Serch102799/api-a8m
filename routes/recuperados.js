const express = require('express');
const router = express.dirname ? express.Router() : express.Router();
const pool = require('../db'); // Ajusta la ruta a tu archivo de conexión a la BD
const verifyToken = require('../middleware/verifyToken'); // Ajusta la ruta a tu middleware

// =======================================================
// OBTENER TODAS LAS PIEZAS RECUPERADAS (Para el Tablero Kanban)
// =======================================================
router.get('/', verifyToken, async (req, res) => {
    try {
        const query = `
            SELECT 
                pr.*, 
                r.nombre AS nombre_pieza, 
                r.numero_parte,
                a_origen.economico AS origen_economico,
                a_destino.economico AS destino_economico,
                p.nombre_proveedor AS nombre_proveedor
            FROM pieza_recuperada pr
            LEFT JOIN refaccion r ON pr.id_refaccion = r.id_refaccion
            LEFT JOIN autobus a_origen ON pr.id_autobus_origen = a_origen.id_autobus
            LEFT JOIN autobus a_destino ON pr.id_autobus_destino = a_destino.id_autobus
            LEFT JOIN proveedor p ON pr.id_proveedor_reparacion = p.id_proveedor
            ORDER BY pr.fecha_baja DESC;
        `;
        const { rows } = await pool.query(query);
        res.status(200).json(rows);
    } catch (error) {
        console.error('Error al obtener piezas recuperadas:', error);
        res.status(500).json({ message: 'Error al obtener los datos.', error: error.message });
    }
});

// =======================================================
// REGISTRAR NUEVA PIEZA AL YONQUE (Ingreso inicial)
// =======================================================
router.post('/', verifyToken, async (req, res) => {
    const { id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones } = req.body;

    try {
        const query = `
            INSERT INTO pieza_recuperada 
            (id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones, estado, fecha_baja) 
            VALUES ($1, $2, $3, $4, $5, 'Yonque', CURRENT_TIMESTAMP) 
            RETURNING *;
        `;
        const values = [id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones];
        const { rows } = await pool.query(query, values);
        res.status(201).json({ message: 'Pieza ingresada al Yonque con éxito.', data: rows[0] });
    } catch (error) {
        console.error('Error al registrar pieza:', error);
        res.status(500).json({ message: 'Error al registrar la pieza.', error: error.message });
    }
});

// =======================================================
// ACTUALIZAR ESTADO Y DATOS DE LA PIEZA (Mover en el Kanban)
// =======================================================
// ==============================
// PUT /api/recuperados/:id (Avanzar Estado y Clonar Lotes)
// ==============================
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { estado, id_autobus_destino, factura_reparacion, cantidad, costo_total_factura } = req.body;

  try {
    // 1. OBTENER LOS DATOS ORIGINALES DE LA PIEZA
    const piezaOriginalReq = await pool.query('SELECT * FROM pieza_recuperada WHERE id_pieza_recuperada = $1', [id]);
    if (piezaOriginalReq.rows.length === 0) return res.status(404).json({ message: 'Pieza no encontrada' });
    
    const pieza = piezaOriginalReq.rows[0];

    // 2. SI ENTRA A STOCK RECUPERADO (Disponible) DESDE EL TALLER
    if (estado === 'Disponible') {
      const cant = parseInt(cantidad) || 1;
      const costoTotal = parseFloat(costo_total_factura) || 0;
      const costoUnitario = cant > 0 ? (costoTotal / cant) : 0;

      // A) Actualizar la pieza actual (la primera del lote)
      await pool.query(
        `UPDATE pieza_recuperada 
         SET estado = $1, factura_reparacion = $2, costo_reparacion = $3, fecha_retorno = CURRENT_DATE 
         WHERE id_pieza_recuperada = $4`,
        [estado, factura_reparacion, costoUnitario, id]
      );

      // B) Si llegaron más de 1, clonar el resto automáticamente
      if (cant > 1) {
        for (let i = 1; i < cant; i++) {
          await pool.query(
            `INSERT INTO pieza_recuperada 
             (id_refaccion, estado, id_autobus_origen, id_proveedor_reparacion, costo_reparacion, factura_reparacion, fecha_baja, fecha_envio, fecha_retorno)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_DATE)`,
            [
              pieza.id_refaccion, 
              estado, 
              pieza.id_autobus_origen, 
              pieza.id_proveedor_reparacion, 
              costoUnitario, 
              factura_reparacion, 
              pieza.fecha_baja, 
              pieza.fecha_envio
            ]
          );
        }
      }
      return res.json({ message: `Se registraron ${cant} piezas en Stock Exitosamente.` });
    }

    // 3. SI EL ESTADO ES 'Instalada' (Lo normal)
    if (estado === 'Instalada') {
      await pool.query(
        `UPDATE pieza_recuperada 
         SET estado = $1, id_autobus_destino = $2, fecha_instalacion = CURRENT_DATE 
         WHERE id_pieza_recuperada = $3`,
        [estado, id_autobus_destino, id]
      );
      return res.json({ message: 'Pieza instalada correctamente.' });
    }

    // 4. CUALQUIER OTRO ESTADO (Ej. Pasar de Yonque a Reparación)
    await pool.query(
      `UPDATE pieza_recuperada SET estado = $1 WHERE id_pieza_recuperada = $2`,
      [estado, id]
    );
    res.json({ message: 'Estado actualizado' });

  } catch (error) {
    console.error('Error al actualizar estado:', error);
    res.status(500).json({ message: 'Error en el servidor al actualizar la pieza' });
  }
});
// =======================================================
// ELIMINAR PIEZA (Si se registró por error)
// =======================================================
router.delete('/:id', verifyToken, async (req, res) => {
    const { id } = req.params;
    try {
        const query = 'DELETE FROM pieza_recuperada WHERE id_pieza_recuperada = $1 RETURNING *;';
        const { rows } = await pool.query(query, [id]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Pieza no encontrada.' });
        }
        res.status(200).json({ message: 'Registro de pieza eliminado correctamente.' });
    } catch (error) {
        console.error('Error al eliminar pieza:', error);
        res.status(500).json({ message: 'Error al eliminar la pieza.', error: error.message });
    }
});

module.exports = router;