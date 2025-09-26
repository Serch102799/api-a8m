const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');


router.post('/', [verifyToken, checkRole(['Admin', 'Almacenista', 'SuperUsuario'])], async (req, res) => {
    const { 
        id_autobus, id_empleado_operador, id_ubicacion, fecha_operacion, 
        km_final, litros_cargados, rutas_realizadas, motivo_desviacion 
    } = req.body;
    const id_empleado_despachador = req.user.id;

    if (!id_autobus || !km_final || !litros_cargados || !fecha_operacion || !id_ubicacion || !rutas_realizadas || rutas_realizadas.length === 0) {
        return res.status(400).json({ message: 'Faltan datos requeridos (autobús, ubicación, km final, litros, fecha y al menos una ruta).' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener datos clave del autobús
        const autobusResult = await client.query(
            'SELECT kilometraje_actual, kilometraje_ultima_carga, rendimiento_esperado FROM autobus WHERE id_autobus = $1 FOR UPDATE', 
            [id_autobus]
        );
        if (autobusResult.rows.length === 0) {
            throw new Error('Autobús no encontrado.');
        }
        
        const { kilometraje_ultima_carga, rendimiento_esperado } = autobusResult.rows[0];
        const km_inicial = kilometraje_ultima_carga;

        // 2. Validar kilometraje
        if (km_final < km_inicial) {
            throw new Error('El kilometraje final no puede ser menor que el de la última carga registrada.');
        }

        // 3. Lógica para seleccionar el tanque automáticamente
        const tanquesDisponibles = await client.query(
            `SELECT id_tanque FROM tanques_combustible 
             WHERE id_ubicacion = $1 AND nivel_actual_litros >= $2 
             ORDER BY nivel_actual_litros DESC LIMIT 1`,
            [id_ubicacion, litros_cargados]
        );
        if (tanquesDisponibles.rows.length === 0) {
            throw new Error('No hay tanques con suficiente combustible en la ubicación seleccionada para esta carga.');
        }
        const id_tanque = tanquesDisponibles.rows[0].id_tanque;

        // 4. Calcular KM esperados
        let km_esperados = 0;
        const idsRutas = rutas_realizadas.map(r => r.id_ruta);
        const rutasResult = await client.query('SELECT id_ruta, kilometraje_vuelta FROM rutas WHERE id_ruta = ANY($1::int[])', [idsRutas]);
        for (const rutaDetalle of rutas_realizadas) {
            const rutaInfo = rutasResult.rows.find(r => r.id_ruta === rutaDetalle.id_ruta);
            if (rutaInfo) {
                km_esperados += rutaInfo.kilometraje_vuelta * rutaDetalle.vueltas;
            }
        }

        // 5. Calcular campos derivados y aplicar reglas de negocio
        const km_recorridos = km_final - km_inicial;
        const desviacion_km = km_recorridos - km_esperados;
        const rendimiento_calculado = litros_cargados > 0 ? km_recorridos / litros_cargados : 0;
        const desviacion_rendimiento = rendimiento_esperado ? rendimiento_calculado - rendimiento_esperado : null;
        const umbral_km = 15;
        const alerta_kilometraje = Math.abs(desviacion_km) > umbral_km;
        const umbral_rendimiento = 0.30;
        const alerta_rendimiento = rendimiento_esperado ? Math.abs(desviacion_rendimiento / rendimiento_esperado) > umbral_rendimiento : false;
        if (alerta_kilometraje && !motivo_desviacion) {
            throw new Error(`La desviación de ${desviacion_km.toFixed(2)} km es muy alta. Se requiere un motivo.`);
        }
        
        // 6. Insertar el registro de carga
        const cargaResult = await client.query(
            `INSERT INTO cargas_combustible (
                id_autobus, id_empleado_operador, id_empleado_despachador, id_tanque, fecha_operacion,
                km_inicial, km_final, km_recorridos, litros_cargados, rendimiento_calculado,
                km_esperados, desviacion_km, rendimiento_esperado, desviacion_rendimiento,
                alerta_kilometraje, alerta_rendimiento, motivo_desviacion
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id_carga`,
            [
                id_autobus, id_empleado_operador, id_empleado_despachador, id_tanque, fecha_operacion,
                km_inicial, km_final, km_recorridos, litros_cargados, rendimiento_calculado.toFixed(2),
                km_esperados, desviacion_km.toFixed(2), rendimiento_esperado, desviacion_rendimiento ? desviacion_rendimiento.toFixed(2) : null,
                alerta_kilometraje, alerta_rendimiento, motivo_desviacion
            ]
        );
        const nuevaCargaId = cargaResult.rows[0].id_carga;

        // 7. Insertar los detalles de las rutas y vueltas
        for (const rutaDetalle of rutas_realizadas) {
            await client.query(`INSERT INTO cargas_combustible_rutas (id_carga, id_ruta, numero_vueltas) VALUES ($1, $2, $3)`, [nuevaCargaId, rutaDetalle.id_ruta, rutaDetalle.vueltas]);
        }
        
        // 8. Actualizar AMBOS kilometrajes del autobús
        await client.query('UPDATE autobus SET kilometraje_actual = $1, kilometraje_ultima_carga = $1 WHERE id_autobus = $2', [km_final, id_autobus]);
        
        // 9. Actualizar el nivel del tanque seleccionado
        await client.query('UPDATE tanques_combustible SET nivel_actual_litros = nivel_actual_litros - $1 WHERE id_tanque = $2', [litros_cargados, id_tanque]);

        await client.query('COMMIT');
        res.status(201).json({ message: 'Carga de combustible registrada exitosamente.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error en transacción de carga de combustible:', error);
        res.status(500).json({ message: error.message || 'Error al procesar la carga.' });
    } finally {
        client.release();
    }
});

// (Aquí puedes añadir tus otros endpoints para el historial de cargas, etc.)
// router.get('/', ...);

module.exports = router;