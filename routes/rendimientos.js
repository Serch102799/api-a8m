const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
// 1. IMPORTAR SERVICIO DE AUDITORÍA
const { registrarAuditoria } = require('../servicios/auditService');

/**
 * @swagger
 * tags:
 * - name: Rendimientos
 * description: Gestión del catálogo de rendimientos de referencia por modelo y ruta.
 */

// GET /api/rendimientos - Obtener lista paginada y con búsqueda (Sin cambios)
router.get('/', verifyToken, async (req, res) => {
    const { page = 1, limit = 10, search = '' } = req.query;
    try {
        const params = [];
        let whereClause = '';
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClause = `WHERE rr.modelo_autobus ILIKE $${params.length} OR r.nombre_ruta ILIKE $${params.length}`;
        }
        
        const totalResult = await pool.query(`
            SELECT COUNT(*) 
            FROM rendimientos_referencia rr 
            JOIN rutas r ON rr.id_ruta = r.id_ruta 
            ${whereClause}
        `, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const offset = (page - 1) * limit;
        const dataResult = await pool.query(
            `SELECT rr.*, r.nombre_ruta 
             FROM rendimientos_referencia rr
             JOIN rutas r ON rr.id_ruta = r.id_ruta
             ${whereClause}
             ORDER BY rr.modelo_autobus ASC, r.nombre_ruta ASC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        
        res.json({ total: totalItems, data: dataResult.rows });
    } catch (error) {
        console.error('Error al obtener rendimientos:', error);
        res.status(500).json({ message: 'Error al obtener rendimientos' });
    }
});

// POST /api/rendimientos - Crear una nueva referencia (CON AUDITORÍA)
router.post('/', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { modelo_autobus, id_ruta, rendimiento_excelente, rendimiento_bueno, rendimiento_regular } = req.body;
    
    if (!modelo_autobus || !id_ruta || !rendimiento_excelente || !rendimiento_bueno || !rendimiento_regular) {
        return res.status(400).json({ message: 'Todos los campos son requeridos.' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO rendimientos_referencia (modelo_autobus, id_ruta, rendimiento_excelente, rendimiento_bueno, rendimiento_regular)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [modelo_autobus, id_ruta, rendimiento_excelente, rendimiento_bueno, rendimiento_regular]
        );

        const nuevoRendimiento = result.rows[0];

        // 🟢 AUDITORÍA
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'CREAR',
            recurso_afectado: 'rendimientos_referencia',
            id_recurso_afectado: nuevoRendimiento.id_rendimiento,
            detalles_cambio: { 
                modelo: modelo_autobus, 
                ruta: id_ruta,
                excelente: rendimiento_excelente,
                bueno: rendimiento_bueno,
                regular: rendimiento_regular
            },
            ip_address: req.ip
        });

        res.status(201).json(nuevoRendimiento);

    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ message: 'Ya existe una referencia para este modelo y ruta.' });
        }
        console.error('Error al crear referencia:', error);
        res.status(500).json({ message: 'Error al crear la referencia' });
    }
});

// PUT /api/rendimientos/:id - Actualizar una referencia (CON AUDITORÍA)
router.put('/:id', [verifyToken, checkRole(['Admin', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { modelo_autobus, id_ruta, rendimiento_excelente, rendimiento_bueno, rendimiento_regular, activo } = req.body;
    
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Obtener valor anterior para auditoría
        const oldDataResult = await client.query('SELECT * FROM rendimientos_referencia WHERE id_rendimiento = $1', [id]);
        if (oldDataResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Referencia no encontrada.' });
        }
        const valorAnterior = oldDataResult.rows[0];

        // 2. Actualizar
        const result = await client.query(
            `UPDATE rendimientos_referencia SET
                modelo_autobus = $1, id_ruta = $2, rendimiento_excelente = $3, 
                rendimiento_bueno = $4, rendimiento_regular = $5, activo = $6, fecha_actualizacion = NOW()
             WHERE id_rendimiento = $7 RETURNING *`,
            [modelo_autobus, id_ruta, rendimiento_excelente, rendimiento_bueno, rendimiento_regular, activo, id]
        );

        const valorNuevo = result.rows[0];

        // 🟢 AUDITORÍA
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'rendimientos_referencia',
            id_recurso_afectado: id,
            detalles_cambio: {
                anterior: {
                    modelo: valorAnterior.modelo_autobus,
                    ruta: valorAnterior.id_ruta,
                    rangos: `${valorAnterior.rendimiento_excelente}/${valorAnterior.rendimiento_bueno}/${valorAnterior.rendimiento_regular}`
                },
                nuevo: {
                    modelo: valorNuevo.modelo_autobus,
                    ruta: valorNuevo.id_ruta,
                    rangos: `${valorNuevo.rendimiento_excelente}/${valorNuevo.rendimiento_bueno}/${valorNuevo.rendimiento_regular}`
                }
            },
            ip_address: req.ip
        });

        await client.query('COMMIT');
        res.json(valorNuevo);

    } catch (error) {
        await client.query('ROLLBACK');
        if (error.code === '23505') {
            return res.status(400).json({ message: 'La combinación de este modelo y ruta ya existe.' });
        }
        console.error('Error al actualizar referencia:', error);
        res.status(500).json({ message: 'Error al actualizar la referencia' });
    } finally {
        client.release();
    }
});

// DELETE /api/rendimientos/:id - Eliminar una referencia (Hard Delete) (CON AUDITORÍA)
router.delete('/:id', [verifyToken, checkRole(['SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Obtener datos antes de borrar
        const oldDataResult = await client.query('SELECT * FROM rendimientos_referencia WHERE id_rendimiento = $1', [id]);
        if (oldDataResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Referencia no encontrada.' });
        }
        const datoEliminado = oldDataResult.rows[0];

        // 2. Eliminar
        await client.query('DELETE FROM rendimientos_referencia WHERE id_rendimiento = $1', [id]);

        // 🟢 AUDITORÍA
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ELIMINAR',
            recurso_afectado: 'rendimientos_referencia',
            id_recurso_afectado: id,
            detalles_cambio: { 
                modelo: datoEliminado.modelo_autobus,
                ruta: datoEliminado.id_ruta
            },
            ip_address: req.ip
        });

        await client.query('COMMIT');
        res.json({ message: 'Referencia eliminada exitosamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error al eliminar referencia:', error);
        res.status(500).json({ message: 'Error al eliminar la referencia' });
    } finally {
        client.release();
    }
});

module.exports = router;