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

module.exports = router;
