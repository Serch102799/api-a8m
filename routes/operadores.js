const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

const { registrarAuditoria } = require('../servicios/auditService');


router.get('/buscar', verifyToken, async (req, res) => {
    const { term } = req.query;
    if (!term || term.length < 1) { return res.json([]); }
    try {
        const searchTerm = `%${term}%`;
        const result = await pool.query(
            `SELECT id_operador, nombre_completo 
             FROM operadores 
             WHERE nombre_completo ILIKE $1 AND esta_activo = true
             ORDER BY nombre_completo ASC LIMIT 10`,
            [searchTerm]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Error al buscar operadores' });
    }
});

router.get('/', verifyToken, async (req, res) => {
    const { page = 1, limit = 10, search = '', estado = 'activos' } = req.query;
    
    try {
        const params = [];
        const whereConditions = [];

        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereConditions.push(`(nombre_completo ILIKE $${params.length} OR numero_empleado ILIKE$${params.length} OR nss ILIKE $${params.length})`);
        }

        if (estado === 'activos') {
            whereConditions.push('esta_activo = true');
        } else if (estado === 'inactivos') {
            whereConditions.push('esta_activo = false');
        }

        const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
        
        const totalResult = await pool.query(`SELECT COUNT(*) FROM operadores ${whereClause}`, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const offset = (page - 1) * limit;
        const dataQuery = `
            SELECT 
                id_operador, nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
                numero_empleado, estatus, nss, estatus_nss, fecha_nacimiento, fecha_ingreso, 
                esta_activo, fecha_baja, motivo_baja, 
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, fecha_nacimiento)) AS edad,
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, fecha_ingreso)) AS antiguedad_anios
            FROM operadores
            ${whereClause}
            ORDER BY nombre_completo ASC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;
        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);
        
        res.json({ total: totalItems, data: dataResult.rows });
    } catch (error) {
        console.error('Error al obtener operadores:', error);
        res.status(500).json({ message: 'Error al obtener operadores' });
    }
});

// ============================================
// POST / - Registro de nuevo operador
// ============================================
router.post('/', [verifyToken, checkRole(['RRHH', 'SuperUsuario'])], async (req, res) => {
    const { 
        nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
        numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss 
    } = req.body;

    if (!nombre_completo) {
        return res.status(400).json({ message: 'El nombre completo es requerido.' });
    }

    try {
        const result = await pool.query(
            `INSERT INTO operadores (
                nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
                numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
                numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss
            ]
        );
        const nuevoOperador = result.rows[0];

        // 🛡️ REGISTRO DE AUDITORÍA: ALTA DE OPERADOR
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'CREAR',
            recurso_afectado: 'operadores',
            id_recurso_afectado: nuevoOperador.id_operador,
            detalles_cambio: { 
                nombre: nuevoOperador.nombre_completo, 
                numero_empleado: nuevoOperador.numero_empleado,
                nss: nuevoOperador.nss 
            },
            ip_address: req.ip
        });

        res.status(201).json(nuevoOperador);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ message: 'El número de licencia, de empleado o NSS ya existe.' });
        }
        console.error('Error al crear el operador:', error);
        res.status(500).json({ message: 'Error al crear el operador' });
    }
});

// ============================================
// PUT /:id - Actualizar Operador
// ============================================
router.put('/:id', [verifyToken, checkRole(['RRHH', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { 
        nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento, 
        numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss 
    } = req.body;
    
    if (!nombre_completo) {
        return res.status(400).json({ message: 'El nombre completo es requerido.' });
    }

    try {
        const result = await pool.query(
            `UPDATE operadores SET
                nombre_completo = $1, numero_licencia = $2, tipo_licencia = $3, 
                licencia_vencimiento = $4, numero_empleado = $5,
                fecha_nacimiento = $6, fecha_ingreso = $7, nss = $8, estatus_nss = $9
             WHERE id_operador = $10 RETURNING *`,
            [
                nombre_completo, numero_licencia, tipo_licencia, licencia_vencimiento,
                numero_empleado, fecha_nacimiento, fecha_ingreso, nss, estatus_nss,
                id
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Operador no encontrado.' });
        }

        const operadorActualizado = result.rows[0];

        // 🛡️ REGISTRO DE AUDITORÍA: EDICIÓN DE OPERADOR
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'operadores',
            id_recurso_afectado: id,
            detalles_cambio: {
                mensaje: 'Se actualizaron los datos personales/laborales del operador.',
                datos_nuevos: req.body // Guardamos el payload que se envió
            },
            ip_address: req.ip
        });

        res.json(operadorActualizado);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(400).json({ message: 'El número de licencia, de empleado o NSS ya está en uso por otro operador.' });
        }
        console.error('Error al actualizar el operador:', error);
        res.status(500).json({ message: 'Error al actualizar el operador' });
    }
});

// ============================================
// PATCH /:id/desactivar - Baja de Operador
// ============================================
router.patch('/:id/desactivar', [verifyToken, checkRole(['RRHH', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;
    const { fecha_baja, motivo_baja } = req.body;

    if (!fecha_baja || !motivo_baja) {
        return res.status(400).json({ message: 'La fecha y el motivo de la baja son requeridos.' });
    }

    try {
        const result = await pool.query(
            `UPDATE operadores 
             SET esta_activo = false, fecha_baja = $1, motivo_baja = $2 
             WHERE id_operador = $3 RETURNING *`,
            [fecha_baja, motivo_baja, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Operador no encontrado.' });
        }

        // 🛡️ REGISTRO DE AUDITORÍA: BAJA LOGICA (ELIMINACIÓN)
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ELIMINAR', // Lo marcamos como ELIMINAR para estandarizar el Log
            recurso_afectado: 'operadores',
            id_recurso_afectado: id,
            detalles_cambio: {
                estado: 'INACTIVO',
                fecha_baja: fecha_baja,
                motivo_baja: motivo_baja
            },
            ip_address: req.ip
        });

        res.json({ message: 'Operador desactivado exitosamente.', operador: result.rows[0] });
    } catch (error) {
        console.error('Error al desactivar el operador:', error);
        res.status(500).json({ message: 'Error al desactivar el operador' });
    }
});

// ============================================
// PATCH /:id/reactivar - Reingreso de Operador
// ============================================
router.patch('/:id/reactivar', [verifyToken, checkRole(['RRHH', 'SuperUsuario'])], async (req, res) => {
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE operadores 
             SET esta_activo = true, fecha_baja = NULL, motivo_baja = NULL 
             WHERE id_operador = $1 RETURNING *`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Operador no encontrado.' });
        }

        // 🛡️ REGISTRO DE AUDITORÍA: REINGRESO (RESTAURACIÓN)
        registrarAuditoria({
            id_usuario: req.user.id,
            tipo_accion: 'ACTUALIZAR',
            recurso_afectado: 'operadores',
            id_recurso_afectado: id,
            detalles_cambio: {
                mensaje: 'Se reactivó al operador (Reingreso a la empresa).',
                estado: 'ACTIVO'
            },
            ip_address: req.ip
        });

        res.json({ message: 'Operador reactivado exitosamente.', operador: result.rows[0] });
    } catch (error) {
        console.error('Error al reactivar el operador:', error);
        res.status(500).json({ message: 'Error al reactivar el operador' });
    }
});

module.exports = router;