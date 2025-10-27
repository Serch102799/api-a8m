const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');

router.get('/', verifyToken, async (req, res) => {
    const {
        page = 1,
        limit = 10,
        search = '',
        id_rutas = '',           // NUEVO: Múltiples rutas separadas por coma
        fecha_desde = '',        // NUEVO: Filtro fecha desde
        fecha_hasta = '',        // NUEVO: Filtro fecha hasta
        tipo_calculo = 'vueltas',
    } = req.query;

    try {
        const params = [];
        let whereClauses = [];

        // --- FILTRO: Búsqueda por económico u operador ---
        if (search.trim()) {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(a.economico ILIKE $${params.length} OR o.nombre_completo ILIKE $${params.length})`);
        }

        // --- FILTRO: Múltiples Rutas (solo en modo vueltas) ---
        if (id_rutas && id_rutas !== '' && tipo_calculo === 'vueltas') {
            const rutasArray = id_rutas.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
            
            if (rutasArray.length > 0) {
                // Usar ANY en PostgreSQL para arrays
                params.push(rutasArray);
                whereClauses.push(`cc.id_carga IN (
                    SELECT DISTINCT id_carga 
                    FROM cargas_combustible_rutas 
                    WHERE id_ruta = ANY($${params.length}::int[])
                )`);
            }
        }

        // --- FILTRO: Fecha Desde ---
        if (fecha_desde && fecha_desde !== '') {
            params.push(fecha_desde);
            whereClauses.push(`cc.fecha_operacion >= $${params.length}::timestamp`);
        }

        // --- FILTRO: Fecha Hasta (incluir todo el día) ---
        if (fecha_hasta && fecha_hasta !== '') {
            params.push(fecha_hasta + ' 23:59:59');
            whereClauses.push(`cc.fecha_operacion <= $${params.length}::timestamp`);
        }

        // --- FILTRO: Tipo de Cálculo ---
        params.push(tipo_calculo);
        whereClauses.push(`cc.tipo_calculo = $${params.length}`);

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // --- Consulta de Conteo Total ---
        const totalQuery = `
            SELECT COUNT(DISTINCT cc.id_carga) as count
            FROM cargas_combustible cc
            LEFT JOIN autobus a ON cc.id_autobus = a.id_autobus
            LEFT JOIN operadores o ON cc.id_empleado_operador = o.id_operador
            ${whereString}
        `;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        // --- Consulta Principal de Datos ---
        const offset = (page - 1) * limit;
        
        // Condicionar el SELECT de rutas según tipo_calculo
        let selectRutas = '';
        if (tipo_calculo === 'vueltas') {
            selectRutas = `(
                SELECT STRING_AGG(r.nombre_ruta || ' (' || ccr.numero_vueltas || ' vueltas)', ', ')
                FROM cargas_combustible_rutas ccr
                JOIN rutas r ON ccr.id_ruta = r.id_ruta
                WHERE ccr.id_carga = cc.id_carga
            ) as rutas_y_vueltas`;
        } else if (tipo_calculo === 'dias') {
            selectRutas = `COALESCE(
                (SELECT r.nombre_ruta FROM rutas r WHERE r.id_ruta = cc.id_ruta_principal),
                'Sin especificar'
            ) as rutas_y_vueltas`;
        }

        const dataQuery = `
            SELECT 
                cc.*,
                a.economico,
                a.modelo,
                a.marca,
                o.nombre_completo as nombre_operador,
                d.nombre as nombre_despachador,
                ${selectRutas},
                
                -- Umbrales de referencia y clasificación
                rr.rendimiento_excelente,
                rr.rendimiento_bueno,
                rr.rendimiento_regular,
                CASE 
                    WHEN cc.rendimiento_calculado >= rr.rendimiento_excelente THEN 'Excelente'
                    WHEN cc.rendimiento_calculado >= rr.rendimiento_bueno THEN 'Bueno'
                    WHEN cc.rendimiento_calculado >= rr.rendimiento_regular THEN 'Regular'
                    WHEN rr.rendimiento_regular IS NOT NULL THEN 'Malo'
                    ELSE NULL
                END as clasificacion_rendimiento
                
            FROM cargas_combustible cc
            LEFT JOIN autobus a ON cc.id_autobus = a.id_autobus
            LEFT JOIN operadores o ON cc.id_empleado_operador = o.id_operador
            LEFT JOIN empleado d ON cc.id_empleado_despachador = d.id_empleado
            
            -- JOIN con rendimientos_referencia
            LEFT JOIN rendimientos_referencia rr 
                ON TRIM(UPPER(rr.modelo_autobus)) = TRIM(UPPER(a.modelo))
                AND rr.activo = TRUE
                AND (
                    (cc.tipo_calculo = 'vueltas' AND rr.id_ruta IN (
                        SELECT DISTINCT id_ruta FROM cargas_combustible_rutas 
                        WHERE id_carga = cc.id_carga
                        LIMIT 1
                    ))
                    OR 
                    (cc.tipo_calculo = 'dias' AND rr.id_ruta = cc.id_ruta_principal)
                )
            
            ${whereString}
            ORDER BY cc.fecha_operacion DESC 
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const dataResult = await pool.query(dataQuery, [...params, limit, offset]);

        // Agregar campo adicional para modo días (días_laborados)
        const dataWithDays = dataResult.rows.map(row => {
            if (tipo_calculo === 'dias') {
                return {
                    ...row,
                    rutas_y_vueltas: `${row.rutas_y_vueltas} (${row.dias_laborados} días)`
                };
            }
            return row;
        });

        res.json({
            total: totalItems,
            data: dataWithDays
        });

    } catch (error) {
        console.error('Error al obtener historial de cargas:', error);
        res.status(500).json({ 
            message: 'Error al obtener el historial',
            error: error.message 
        });
    }
});

router.post('/', [verifyToken, checkRole(['AdminDiesel', 'Almacenista', 'SuperUsuario', 'Admin'])], async (req, res) => {
    // CAMBIO: Se reciben los nuevos campos para el cálculo dual
    const {
        id_autobus, id_empleado_operador, id_ubicacion, fecha_operacion,
        km_final, litros_cargados, motivo_desviacion,
        tipo_calculo, // 'dias' o 'vueltas'
        id_ruta_principal, // para el modo 'dias'
        dias_laborados,    // para el modo 'dias'
        rutas_realizadas   // para el modo 'vueltas'
    } = req.body;
    const id_empleado_despachador = req.user.id;

    if (!id_autobus || !km_final || !litros_cargados || !fecha_operacion || !id_ubicacion) {
        return res.status(400).json({ message: 'Faltan datos requeridos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Obtener datos del autobús (sin cambios)
        const autobusResult = await client.query('SELECT kilometraje_ultima_carga, rendimiento_esperado FROM autobus WHERE id_autobus = $1 FOR UPDATE', [id_autobus]);
        if (autobusResult.rows.length === 0) throw new Error('Autobús no encontrado.');
        const { kilometraje_ultima_carga, rendimiento_esperado } = autobusResult.rows[0];
        const km_inicial = kilometraje_ultima_carga;
        if (km_final < km_inicial) throw new Error('El kilometraje final no puede ser menor que el de la última carga.');

        // 2. Lógica del tanque (sin cambios)
        const tanquesDisponibles = await client.query(`SELECT id_tanque FROM tanques_combustible WHERE id_ubicacion = $1 AND nivel_actual_litros >= $2 ORDER BY nivel_actual_litros DESC LIMIT 1`, [id_ubicacion, litros_cargados]);
        if (tanquesDisponibles.rows.length === 0) throw new Error('No hay tanques con suficiente combustible en la ubicación seleccionada.');
        const id_tanque = tanquesDisponibles.rows[0].id_tanque;

        // 3. CAMBIO: Calcular KM esperados con la nueva lógica dual
        let km_esperados = 0;
        if (tipo_calculo === 'dias' && id_ruta_principal && dias_laborados > 0) {
            const rutaResult = await client.query('SELECT kilometraje_vuelta, vueltas_diarias_promedio FROM rutas WHERE id_ruta = $1', [id_ruta_principal]);
            if (rutaResult.rows.length > 0) {
                const { kilometraje_vuelta, vueltas_diarias_promedio } = rutaResult.rows[0];
                km_esperados = dias_laborados * vueltas_diarias_promedio * kilometraje_vuelta;
            }
        } else if (tipo_calculo === 'vueltas' && rutas_realizadas && rutas_realizadas.length > 0) {
            const idsRutas = rutas_realizadas.map(r => r.id_ruta);
            const rutasResult = await client.query('SELECT id_ruta, kilometraje_vuelta FROM rutas WHERE id_ruta = ANY($1::int[])', [idsRutas]);
            for (const rutaDetalle of rutas_realizadas) {
                const rutaInfo = rutasResult.rows.find(r => r.id_ruta === rutaDetalle.id_ruta);
                if (rutaInfo) {
                    km_esperados += rutaInfo.kilometraje_vuelta * rutaDetalle.vueltas;
                }
            }
        }

        // 4. Calcular campos derivados y aplicar reglas de negocio (sin cambios)
        const km_recorridos = km_final - km_inicial;
        const desviacion_km = km_recorridos - km_esperados;
        const rendimiento_calculado = litros_cargados > 0 ? km_recorridos / litros_cargados : 0;
        const umbral_km = 15;
        const alerta_kilometraje = Math.abs(desviacion_km) > umbral_km;
        if (alerta_kilometraje && !motivo_desviacion) {
            throw new Error(`La desviación de ${desviacion_km.toFixed(2)} km es muy alta. Se requiere un motivo.`);
        }

        // 5. Insertar el registro de carga con los campos correspondientes
        const cargaResult = await client.query(
            `INSERT INTO cargas_combustible (
        id_autobus, id_empleado_operador, id_empleado_despachador, id_tanque, fecha_operacion,
        km_inicial, km_final, km_recorridos, litros_cargados, rendimiento_calculado,
        km_esperados, desviacion_km, rendimiento_esperado, alerta_kilometraje, motivo_desviacion,
        id_ruta_principal, dias_laborados, tipo_calculo
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id_carga`,
            [
                id_autobus, id_empleado_operador, id_empleado_despachador, id_tanque, fecha_operacion,
                km_inicial, km_final, km_recorridos, litros_cargados, rendimiento_calculado,
                km_esperados, desviacion_km, rendimiento_esperado, alerta_kilometraje, motivo_desviacion,
                tipo_calculo === 'dias' ? id_ruta_principal : null,  // <-- AQUÍ: null si es 'vueltas'
                tipo_calculo === 'dias' ? dias_laborados : null,      // <-- AQUÍ: null si es 'vueltas'
                tipo_calculo
            ]
        );
        const nuevaCargaId = cargaResult.rows[0].id_carga;

        // 6. Insertar los detalles de las rutas (solo si el modo es 'vueltas')
        if (tipo_calculo === 'vueltas' && rutas_realizadas) {
            for (const rutaDetalle of rutas_realizadas) {
                await client.query(`INSERT INTO cargas_combustible_rutas (id_carga, id_ruta, numero_vueltas) VALUES ($1, $2, $3)`, [nuevaCargaId, rutaDetalle.id_ruta, rutaDetalle.vueltas]);
            }
        }

        // 7. Actualizar kilometrajes del autobús (sin cambios)
        await client.query('UPDATE autobus SET kilometraje_actual = $1, kilometraje_ultima_carga = $1 WHERE id_autobus = $2', [km_final, id_autobus]);

        // 8. Actualizar el nivel del tanque (sin cambios)
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


module.exports = router;