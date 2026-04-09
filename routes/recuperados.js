const express = require('express');
const router = express.dirname ? express.Router() : express.Router();
const pool = require('../db'); 
const verifyToken = require('../middleware/verifyToken'); 

const { registrarAuditoria } = require('../servicios/auditService');

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
    const { id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones, fecha_operacion } = req.body;

    try {
        const fechaBaja = fecha_operacion || new Date().toISOString().split('T')[0];

        const query = `
            INSERT INTO pieza_recuperada 
            (id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones, estado, fecha_baja) 
            VALUES ($1, $2, $3, $4, $5, 'Yonque', $6) 
            RETURNING *;
        `;
        const values = [id_refaccion, numero_serie, id_autobus_origen, motivo_falla, observaciones, fechaBaja];
        
        const { rows } = await pool.query(query, values);
        const nuevaPieza = rows[0];

        // 🛡️ REGISTRO DE AUDITORÍA: ALTA EN YONQUE
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'CREAR',
            recurso_afectado: 'pieza_recuperada',
            id_recurso_afectado: nuevaPieza.id_pieza_recuperada,
            detalles_cambio: {
                mensaje: 'Se ingresó una pieza (casco) al Yonque.',
                estado: 'Yonque',
                numero_serie: numero_serie,
                id_autobus_origen: id_autobus_origen,
                motivo_falla: motivo_falla
            },
            ip_address: req.ip
        });

        res.status(201).json({ message: 'Pieza ingresada al Yonque con éxito.', data: nuevaPieza });
    } catch (error) {
        console.error('Error al registrar pieza:', error);
        res.status(500).json({ message: 'Error al registrar la pieza.', error: error.message });
    }
});

// =======================================================
// ACTUALIZAR ESTADO Y DATOS DE LA PIEZA (Mover en el Kanban)
// =======================================================
router.put('/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { estado, id_autobus_destino, factura_reparacion, cantidad, costo_total_factura, id_proveedor_reparacion, fecha_operacion } = req.body;

  try {
    // 1. OBTENER LOS DATOS ORIGINALES DE LA PIEZA
    const piezaOriginalReq = await pool.query('SELECT * FROM pieza_recuperada WHERE id_pieza_recuperada = $1', [id]);
    if (piezaOriginalReq.rows.length === 0) return res.status(404).json({ message: 'Pieza no encontrada' });
    
    const pieza = piezaOriginalReq.rows[0];
    const fechaOp = fecha_operacion || new Date().toISOString().split('T')[0];

    // 2. SI SE ENVÍA A REPARAR
    if (estado === 'En Reparación') {
      await pool.query(
        `UPDATE pieza_recuperada 
         SET estado = $1, id_proveedor_reparacion = $2, fecha_envio = $3 
         WHERE id_pieza_recuperada = $4`,
        [estado, id_proveedor_reparacion, fechaOp, id]
      );

      // 🛡️ AUDITORÍA
      registrarAuditoria({
          id_usuario: req.user.id,
          tipo_accion: 'ACTUALIZAR',
          recurso_afectado: 'pieza_recuperada',
          id_recurso_afectado: id,
          detalles_cambio: { estado_anterior: pieza.estado, estado_nuevo: estado, proveedor_reparacion: id_proveedor_reparacion },
          ip_address: req.ip
      });

      return res.json({ message: 'Pieza enviada a reparación.' });
    }

    // 3. SI ENTRA A STOCK RECUPERADO (Disponible) DESDE EL TALLER
    if (estado === 'Disponible') {
      const cant = parseInt(cantidad) || 1;
      const costoTotal = parseFloat(costo_total_factura) || 0;
      const costoUnitario = cant > 0 ? (costoTotal / cant) : 0;

      await pool.query(
        `UPDATE pieza_recuperada 
         SET estado = $1, factura_reparacion = $2, costo_reparacion = $3, fecha_retorno = $4 
         WHERE id_pieza_recuperada = $5`,
        [estado, factura_reparacion, costoUnitario, fechaOp, id]
      );

      if (cant > 1) {
        for (let i = 1; i < cant; i++) {
          await pool.query(
            `INSERT INTO pieza_recuperada 
             (id_refaccion, estado, id_autobus_origen, id_proveedor_reparacion, costo_reparacion, factura_reparacion, fecha_baja, fecha_envio, fecha_retorno)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              pieza.id_refaccion, estado, pieza.id_autobus_origen, pieza.id_proveedor_reparacion, 
              costoUnitario, factura_reparacion, pieza.fecha_baja, pieza.fecha_envio, fechaOp
            ]
          );
        }
      }

      // 🛡️ AUDITORÍA
      registrarAuditoria({
          id_usuario: req.user.id,
          tipo_accion: 'ACTUALIZAR',
          recurso_afectado: 'pieza_recuperada',
          id_recurso_afectado: id,
          detalles_cambio: { 
              estado_anterior: pieza.estado, 
              estado_nuevo: estado, 
              costo_reparacion: costoUnitario, 
              factura: factura_reparacion,
              piezas_clonadas_agregadas: cant - 1
          },
          ip_address: req.ip
      });

      return res.json({ message: `Se registraron ${cant} piezas en Stock Exitosamente.` });
    }

    // 4. SI EL ESTADO ES 'Instalada' (Puesta en Bus)
    if (estado === 'Instalada') {
      await pool.query(
        `UPDATE pieza_recuperada 
         SET estado = $1, id_autobus_destino = $2, fecha_instalacion = $3 
         WHERE id_pieza_recuperada = $4`,
        [estado, id_autobus_destino, fechaOp, id]
      );

      // 🛡️ AUDITORÍA
      registrarAuditoria({
          id_usuario: req.user.id,
          tipo_accion: 'ACTUALIZAR',
          recurso_afectado: 'pieza_recuperada',
          id_recurso_afectado: id,
          detalles_cambio: { estado_anterior: pieza.estado, estado_nuevo: estado, id_autobus_destino: id_autobus_destino },
          ip_address: req.ip
      });

      return res.json({ message: 'Pieza instalada correctamente.' });
    }

    // 5. CUALQUIER OTRO ESTADO (Fallback)
    await pool.query(
      `UPDATE pieza_recuperada SET estado = $1 WHERE id_pieza_recuperada = $2`,
      [estado, id]
    );

    // 🛡️ AUDITORÍA (Fallback)
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'pieza_recuperada',
        id_recurso_afectado: id,
        detalles_cambio: { estado_anterior: pieza.estado, estado_nuevo: estado },
        ip_address: req.ip
    });

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

        const piezaEliminada = rows[0];

        // 🛡️ REGISTRO DE AUDITORÍA: ELIMINAR
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ELIMINAR',
            recurso_afectado: 'pieza_recuperada',
            id_recurso_afectado: id,
            detalles_cambio: { 
                mensaje: 'Se eliminó una pieza recuperada del registro.',
                estado_al_borrar: piezaEliminada.estado, 
                numero_serie: piezaEliminada.numero_serie 
            },
            ip_address: req.ip
        });

        res.status(200).json({ message: 'Registro de pieza eliminado correctamente.' });
    } catch (error) {
        console.error('Error al eliminar pieza:', error);
        res.status(500).json({ message: 'Error al eliminar la pieza.', error: error.message });
    }
});

// =======================================================
// REVERTIR INSTALACIÓN POR ERROR
// =======================================================
router.put('/:id/revertir-instalacion', verifyToken, async (req, res) => {
  const { id } = req.params;
  const { motivo_reversion, usuario_que_revierte } = req.body;

  try {
    const pieza = await pool.query(`
      SELECT p.motivo_falla, a.economico as bus_destino 
      FROM pieza_recuperada p
      LEFT JOIN autobus a ON p.id_autobus_destino = a.id_autobus
      WHERE p.id_pieza_recuperada = $1
    `, [id]);
    
    if (pieza.rows.length === 0) return res.status(404).json({ message: 'Pieza no encontrada' });

    const busEquivocado = pieza.rows[0].bus_destino || 'Desconocido';
    const fallaAnterior = pieza.rows[0].motivo_falla || '';

    const fechaActual = new Date().toLocaleDateString();
    const huella = `\n[${fechaActual} - REVERTIDO POR ${usuario_que_revierte}]: Se desinstaló por error del Bus ${busEquivocado}. Motivo: ${motivo_reversion}`;
    const nuevoHistorial = fallaAnterior + huella;

    await pool.query(`
      UPDATE pieza_recuperada 
      SET estado = 'Disponible', 
          id_autobus_destino = NULL, 
          fecha_instalacion = NULL,
          motivo_falla = $1
      WHERE id_pieza_recuperada = $2
    `, [nuevoHistorial, id]);

    // 🛡️ REGISTRO DE AUDITORÍA: REVERSIÓN DE INSTALACIÓN
    registrarAuditoria({
        id_usuario: req.user.id,
        tipo_accion: 'ACTUALIZAR',
        recurso_afectado: 'pieza_recuperada',
        id_recurso_afectado: id,
        detalles_cambio: { 
            accion: 'REVERSION_DE_INSTALACION',
            bus_retirado: busEquivocado,
            motivo: motivo_reversion,
            usuario_mencionado: usuario_que_revierte
        },
        ip_address: req.ip
    });

    res.json({ message: 'Instalación revertida y gasto anulado correctamente.' });

  } catch (error) {
    console.error('Error al revertir instalación:', error);
    res.status(500).json({ message: 'Error interno al revertir la pieza.' });
  }
});

module.exports = router;