const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

/**
 * @swagger
 * tags:
 *   - name: Entradas
 *     description: Gestión de entradas al almacén
 */

/**
 * @swagger
 * /api/entradas/{id}:
 *   put:
 *     summary: Editar la fecha de operación de una entrada
 *     description: 
 *       Permite a un **SuperUsuario** actualizar la fecha de operación de una entrada del almacén.  
 *       El cambio se registra en la tabla de auditoría (`log_modificaciones`).
 *     tags: [Entradas]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de la entrada a modificar
 *         example: 15
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fecha_operacion
 *               - motivo
 *             properties:
 *               fecha_operacion:
 *                 type: string
 *                 format: date
 *                 description: Nueva fecha de operación de la entrada
 *                 example: "2025-09-01"
 *               motivo:
 *                 type: string
 *                 description: Razón de la modificación (para fines de auditoría)
 *                 example: "Corrección de error en la fecha capturada originalmente"
 *     responses:
 *       200:
 *         description: La fecha fue actualizada y el cambio quedó registrado en la auditoría.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "La fecha de la entrada ha sido actualizada y el cambio ha sido registrado."
 *       400:
 *         description: Faltan datos en la solicitud (fecha o motivo).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Se requiere la nueva fecha y un motivo para la modificación."
 *       401:
 *         description: Token no proporcionado o inválido.
 *       403:
 *         description: Acceso denegado. Solo los usuarios con rol SuperUsuario pueden modificar la entrada.
 *       404:
 *         description: La entrada no fue encontrada.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "La entrada no fue encontrada."
 *       500:
 *         description: Error interno al procesar la actualización.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Error al actualizar la entrada."
 */
router.put(
  '/entradas/:id',
  [verifyToken, checkRole(['SuperUsuario'])],
  async (req, res) => {
    const { id } = req.params;
    const { fecha_operacion, motivo } = req.body;
    const id_empleado = req.user.id; // Obtenido del token JWT

    if (!fecha_operacion || !motivo) {
      return res.status(400).json({
        message:
          'Se requiere la nueva fecha y un motivo para la modificación.',
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Obtener el valor anterior
      const oldValueResult = await client.query(
        'SELECT fecha_operacion FROM entrada_almacen WHERE id_entrada = $1',
        [id]
      );
      if (oldValueResult.rows.length === 0) {
        throw new Error('La entrada no fue encontrada.');
      }
      const valorAnterior = oldValueResult.rows[0].fecha_operacion;

      // 2. Actualizar la fecha
      await client.query(
        'UPDATE entrada_almacen SET fecha_operacion = $1 WHERE id_entrada = $2',
        [fecha_operacion, id]
      );

      // 3. Registrar auditoría
      await client.query(
        `INSERT INTO log_modificaciones 
         (id_empleado, tabla_modificada, id_registro_modificado, campo_modificado, valor_anterior, valor_nuevo, motivo)
         VALUES ($1, 'entrada_almacen', $2, 'fecha_operacion', $3, $4, $5)`,
        [id_empleado, id, valorAnterior, fecha_operacion, motivo]
      );

      await client.query('COMMIT');
      res.status(200).json({
        message:
          'La fecha de la entrada ha sido actualizada y el cambio ha sido registrado.',
      });
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error en la transacción de edición de entrada:', error);

      if (error.message === 'La entrada no fue encontrada.') {
        return res.status(404).json({ message: error.message });
      }

      res.status(500).json({ message: 'Error al actualizar la entrada.' });
    } finally {
      client.release();
    }
  }
);

router.put('/salidas/:id', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { fecha_operacion, motivo } = req.body;
    const id_empleado = req.user.id; // Obtenido del token JWT del SuperUsuario

    if (!fecha_operacion || !motivo || motivo.trim() === '') {
        return res.status(400).json({ message: 'Se requiere la nueva fecha y un motivo para la modificación.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener el valor antiguo para la auditoría
        const oldValueResult = await client.query('SELECT fecha_operacion FROM salida_almacen WHERE id_salida = $1', [id]);
        if (oldValueResult.rows.length === 0) {
            throw new Error('La salida no fue encontrada.');
        }
        const valorAnterior = oldValueResult.rows[0].fecha_operacion;

        // 2. Actualizar el registro en la tabla principal
        await client.query(
            'UPDATE salida_almacen SET fecha_operacion = $1 WHERE id_salida = $2',
            [fecha_operacion, id]
        );

        // 3. Insertar el registro en la tabla de auditoría
        await client.query(
            `INSERT INTO log_modificaciones 
             (id_empleado, tabla_modificada, id_registro_modificado, campo_modificado, valor_anterior, valor_nuevo, motivo)
             VALUES ($1, 'salida_almacen', $2, 'fecha_operacion', $3, $4, $5)`,
            [id_empleado, id, valorAnterior, fecha_operacion, motivo]
        );

        await client.query('COMMIT');
        res.status(200).json({ message: 'La fecha de la salida ha sido actualizada y el cambio ha sido registrado.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en la transacción de edición de salida:', error);
        // Si el error es por 'not found', devolvemos un 404
        if (error.message === 'La salida no fue encontrada.') {
            return res.status(404).json({ message: error.message });
        }
        res.status(500).json({ message: 'Error al actualizar la salida.' });
    } finally {
        client.release();
    }
});

router.get('/detalles-entrada', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
    try {
        const { page = 1, limit = 15, search = '' } = req.query;
        const params = [];
        let whereClause = '';
        if (search) {
            params.push(`%${search}%`);
            whereClause = `WHERE nombre_item ILIKE $${params.length}`;
        }

        const totalQuery = `SELECT COUNT(*) FROM (
            SELECT r.nombre AS nombre_item FROM detalle_entrada de JOIN refaccion r ON de.id_refaccion = r.id_refaccion
            UNION ALL
            SELECT i.nombre AS nombre_item FROM detalle_entrada_insumo dei JOIN insumo i ON dei.id_insumo = i.id_insumo
        ) as all_details ${whereClause}`;
        
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);
        const offset = (page - 1) * limit;
        
        const dataQuery = `
            SELECT * FROM (
                SELECT 
                    de.id_detalle_entrada as id_detalle, 
                    'refaccion' as tipo, 
                    e.fecha_operacion, 
                    r.nombre as nombre_item, 
                    de.cantidad_recibida, 
                    l.costo_unitario_final as costo,
                    de.id_entrada
                FROM detalle_entrada de
                JOIN entrada_almacen e ON de.id_entrada = e.id_entrada
                JOIN refaccion r ON de.id_refaccion = r.id_refaccion
                JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada
                
                UNION ALL

                SELECT 
                    dei.id_detalle_insumo as id_detalle, 
                    'insumo' as tipo, 
                    e.fecha_operacion, 
                    i.nombre as nombre_item, 
                    dei.cantidad_recibida, 
                    dei.costo_unitario_final as costo,
                    dei.id_entrada
                FROM detalle_entrada_insumo dei
                JOIN entrada_almacen e ON dei.id_entrada = e.id_entrada
                JOIN insumo i ON dei.id_insumo = i.id_insumo
            ) as all_details
            ${whereClause}
            ORDER BY fecha_operacion DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

        res.json({ total: totalItems, data: dataResult.rows });

    } catch (error) {
        console.error("Error al obtener detalles de entrada:", error);
        res.status(500).json({ message: 'Error al obtener detalles de entrada' });
    }
});

// --- PUT /superadmin/detalles-entrada/:tipo/:id (Editar un detalle) ---
router.put('/detalles-entrada/:tipo/:id', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
    const { tipo, id } = req.params;
    const { cantidad_recibida, costo, motivo } = req.body;
    const id_empleado = req.user.id;

    if (!motivo || !cantidad_recibida || !costo) {
        return res.status(400).json({ message: 'Todos los campos y el motivo son requeridos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        if (tipo === 'refaccion') {
            const oldDetail = await client.query('SELECT * FROM detalle_entrada WHERE id_detalle_entrada = $1', [id]);
            if (oldDetail.rows.length === 0) throw new Error('Detalle de refacción no encontrado.');

            const oldCantidad = oldDetail.rows[0].cantidad_recibida;
            const id_refaccion = oldDetail.rows[0].id_refaccion;

            const lote = await client.query('SELECT * FROM lote_refaccion WHERE id_detalle_entrada = $1 FOR UPDATE', [id]);
            if (lote.rows.length === 0) throw new Error('Lote asociado no encontrado.');
            const oldCostoFinal = lote.rows[0].costo_unitario_final;
            
            // Revertir stock del lote (peligroso si ya hubo salidas, se debe validar)
            const cantidadDiferencia = parseFloat(cantidad_recibida) - parseFloat(oldCantidad);
            if (parseFloat(lote.rows[0].cantidad_disponible) + cantidadDiferencia < 0) {
                throw new Error('No se puede reducir la cantidad por debajo de lo ya despachado.');
            }

            await client.query('UPDATE lote_refaccion SET cantidad_disponible = cantidad_disponible + $1, costo_unitario_final = $2, costo_unitario_subtotal = $2, monto_iva_unitario = 0 WHERE id_detalle_entrada = $3', [cantidadDiferencia, costo, id]);
            await client.query('UPDATE detalle_entrada SET cantidad_recibida = $1, costo_unitario_entrada = $2 WHERE id_detalle_entrada = $3', [cantidad_recibida, costo, id]);

            const logDescription = `Cant: ${oldCantidad}->${cantidad_recibida}, Costo: ${oldCostoFinal}->${costo}`;
            await client.query(`INSERT INTO log_modificaciones (id_empleado, tabla_modificada, id_registro_modificado, campo_modificado, valor_anterior, valor_nuevo, motivo) VALUES ($1, 'detalle_entrada', $2, 'cantidad_y_costo', $3, $4, $5)`, [id_empleado, id, `Cant:${oldCantidad},Costo:${oldCostoFinal}`, `Cant:${cantidad_recibida},Costo:${costo}`, motivo]);

        } else if (tipo === 'insumo') {
            const oldDetail = await client.query('SELECT * FROM detalle_entrada_insumo WHERE id_detalle_insumo = $1', [id]);
            if (oldDetail.rows.length === 0) throw new Error('Detalle de insumo no encontrado.');
            
            const oldCantidad = oldDetail.rows[0].cantidad_recibida;
            const oldCostoFinal = oldDetail.rows[0].costo_unitario_final;
            const id_insumo = oldDetail.rows[0].id_insumo;
            
            const insumo = await client.query('SELECT * FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id_insumo]);

            let stockActual = parseFloat(insumo.rows[0].stock_actual);
            let costoPromedio = parseFloat(insumo.rows[0].costo_unitario_promedio);
            let valorTotal = stockActual * costoPromedio;
            
            stockActual -= parseFloat(oldCantidad);
            valorTotal -= parseFloat(oldCantidad) * parseFloat(oldCostoFinal);
            
            const nuevaCantidad = parseFloat(cantidad_recibida);
            const nuevoCostoFinal = parseFloat(costo);
            
            stockActual += nuevaCantidad;
            valorTotal += nuevaCantidad * nuevoCostoFinal;
            costoPromedio = stockActual > 0 ? valorTotal / stockActual : 0;

            await client.query('UPDATE insumo SET stock_actual = $1, costo_unitario_promedio = $2 WHERE id_insumo = $3', [stockActual, costoPromedio, id_insumo]);
            await client.query('UPDATE detalle_entrada_insumo SET cantidad_recibida = $1, costo_unitario_final = $2, costo_unitario_subtotal = $2, monto_iva_unitario = 0 WHERE id_detalle_insumo = $3', [nuevaCantidad, nuevoCostoFinal, id]);

            await client.query(`INSERT INTO log_modificaciones (id_empleado, tabla_modificada, id_registro_modificado, campo_modificado, valor_anterior, valor_nuevo, motivo) VALUES ($1, 'detalle_entrada_insumo', $2, 'cantidad_y_costo', $3, $4, $5)`, [id_empleado, id, `Cant:${oldCantidad},Costo:${oldCostoFinal}`, `Cant:${nuevaCantidad},Costo:${nuevoCostoFinal}`, motivo]);

        } else {
            throw new Error('Tipo de detalle no válido.');
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'El detalle de la entrada ha sido actualizado y el cambio ha sido registrado.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de edición de detalle:', error);
        res.status(500).json({ message: error.message || 'Error al actualizar el detalle.' });
    } finally {
        client.release();
    }
});


// --- DELETE /superadmin/detalles-entrada/:tipo/:id (Eliminar un detalle) ---
router.delete('/detalles-entrada/:tipo/:id', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
    const { tipo, id } = req.params;
    const { motivo } = req.body;
    const id_empleado = req.user.id;

    if (!motivo) {
        return res.status(400).json({ message: 'Se requiere un motivo para la eliminación.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (tipo === 'refaccion') {
            const oldDetail = await client.query('SELECT * FROM detalle_entrada WHERE id_detalle_entrada = $1', [id]);
            if (oldDetail.rows.length === 0) throw new Error('Detalle de refacción no encontrado.');
            
            const lote = await client.query('SELECT * FROM lote_refaccion WHERE id_detalle_entrada = $1', [id]);
            if (parseFloat(lote.rows[0].cantidad_disponible) < parseFloat(oldDetail.rows[0].cantidad_recibida)) {
                throw new Error('No se puede eliminar una entrada cuyo lote ya ha tenido salidas.');
            }

            await client.query('DELETE FROM lote_refaccion WHERE id_detalle_entrada = $1', [id]);
            await client.query('DELETE FROM detalle_entrada WHERE id_detalle_entrada = $1', [id]);

            await client.query(`INSERT INTO log_modificaciones (id_empleado, tabla_modificada, id_registro_modificado, campo_modificado, valor_anterior, motivo) VALUES ($1, 'detalle_entrada', $2, 'eliminacion', $3, $4)`, [id_empleado, id, JSON.stringify(oldDetail.rows[0]), motivo]);
            
        } else if (tipo === 'insumo') {
            const oldDetail = await client.query('SELECT * FROM detalle_entrada_insumo WHERE id_detalle_insumo = $1', [id]);
            if (oldDetail.rows.length === 0) throw new Error('Detalle de insumo no encontrado.');

            const { id_insumo, cantidad_recibida, costo_unitario_final } = oldDetail.rows[0];
            const insumo = await client.query('SELECT * FROM insumo WHERE id_insumo = $1 FOR UPDATE', [id_insumo]);
            if (parseFloat(insumo.rows[0].stock_actual) < parseFloat(cantidad_recibida)) {
                throw new Error('No se puede eliminar la entrada porque el stock actual es menor a la cantidad recibida (ya hubo salidas).');
            }

            let stockActual = parseFloat(insumo.rows[0].stock_actual);
            let costoPromedio = parseFloat(insumo.rows[0].costo_unitario_promedio);
            let valorTotal = stockActual * costoPromedio;

            stockActual -= parseFloat(cantidad_recibida);
            valorTotal -= parseFloat(cantidad_recibida) * parseFloat(costo_unitario_final);
            costoPromedio = stockActual > 0 ? valorTotal / stockActual : 0;

            await client.query('UPDATE insumo SET stock_actual = $1, costo_unitario_promedio = $2 WHERE id_insumo = $3', [stockActual, costoPromedio, id_insumo]);
            await client.query('DELETE FROM detalle_entrada_insumo WHERE id_detalle_insumo = $1', [id]);

            await client.query(`INSERT INTO log_modificaciones (id_empleado, tabla_modificada, id_registro_modificado, campo_modificado, valor_anterior, motivo) VALUES ($1, 'detalle_entrada_insumo', $2, 'eliminacion', $3, $4)`, [id_empleado, id, JSON.stringify(oldDetail.rows[0]), motivo]);

        } else {
            throw new Error('Tipo de detalle no válido.');
        }

        await client.query('COMMIT');
        res.status(200).json({ message: 'El detalle de la entrada ha sido eliminado y el cambio ha sido registrado.' });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de eliminación de detalle:', error);
        res.status(500).json({ message: error.message || 'Error al eliminar el detalle.' });
    } finally {
        client.release();
    }
});

module.exports = router;
