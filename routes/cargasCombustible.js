const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const checkRole = require('../middleware/checkRole');
const { registrarAuditoria } = require('../servicios/auditService');

// ============================================
// GET / - Listado con filtros 
// ============================================
router.get('/', verifyToken, async (req, res) => {
    const {
        page = 1,
        limit = 10,
        search = '',
        id_rutas = '',
        fecha_desde = '',
        fecha_hasta = '',
        // Lo dejamos vacío por defecto para que el Dashboard traiga todo el consumo
        tipo_calculo = '', 
    } = req.query;

    try {
        const params = [];
        let whereClauses = [];

        // 1. FILTRO DE BÚSQUEDA UNIVERSAL (Económico, Operador o RUTA)
        // ¡Aquí está la magia para que el Dashboard detecte la ruta escrita!
        if (search && search.trim() !== '') {
            params.push(`%${search.trim()}%`);
            whereClauses.push(`(
                a.economico ILIKE $${params.length} 
                OR o.nombre_completo ILIKE $${params.length}
                OR cc.id_carga IN (
                    SELECT ccr.id_carga 
                    FROM cargas_combustible_rutas ccr 
                    JOIN rutas r ON ccr.id_ruta = r.id_ruta 
                    WHERE r.nombre_ruta ILIKE $${params.length}
                )
                OR cc.id_ruta_principal IN (
                    SELECT r.id_ruta 
                    FROM rutas r 
                    WHERE r.nombre_ruta ILIKE $${params.length}
                )
            )`);
        }

        // 2. Filtro de Rutas por Checkbox (Para la tabla de Historial)
        if (id_rutas && id_rutas !== '') {
            const rutasArray = id_rutas.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
            if (rutasArray.length > 0) {
                params.push(rutasArray);
                whereClauses.push(`cc.id_carga IN (
                    SELECT DISTINCT id_carga 
                    FROM cargas_combustible_rutas 
                    WHERE id_ruta = ANY($${params.length}::int[])
                )`);
            }
        }

        // 3. Filtros de Fecha
        if (fecha_desde && fecha_desde !== '') {
            params.push(fecha_desde);
            whereClauses.push(`cc.fecha_operacion >=$${params.length}::timestamp`);
        }

        if (fecha_hasta && fecha_hasta !== '') {
            params.push(fecha_hasta + ' 23:59:59');
            whereClauses.push(`cc.fecha_operacion <= $${params.length}::timestamp`);
        }

        // 4. Filtro por Tipo de Cálculo (Solo se aplica si se envía explícitamente)
        if (tipo_calculo && tipo_calculo !== '') {
            params.push(tipo_calculo);
            whereClauses.push(`cc.tipo_calculo =$${params.length}`);
        }

        const whereString = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

        // --- CONSULTA PARA OBTENER EL TOTAL DE REGISTROS (PAGINACIÓN) ---
        const totalQuery = `
            SELECT COUNT(DISTINCT cc.id_carga) as count
            FROM cargas_combustible cc
            LEFT JOIN autobus a ON cc.id_autobus = a.id_autobus
            LEFT JOIN operadores o ON cc.id_empleado_operador = o.id_operador
            ${whereString}
        `;
        const totalResult = await pool.query(totalQuery, params);
        const totalItems = parseInt(totalResult.rows[0].count, 10);

        const offset = (page - 1) * limit;
        
        // --- CONSULTA PRINCIPAL PARA OBTENER LOS DATOS ---
        const dataQuery = `
            SELECT 
                cc.*,
                a.economico,
                a.modelo,
                a.marca,
                o.nombre_completo as nombre_operador,
                d.nombre as nombre_despachador,
                CASE 
                    WHEN cc.tipo_calculo = 'vueltas' THEN (
                        SELECT STRING_AGG(r.nombre_ruta || ' (' || ccr.numero_vueltas || ' vueltas)', ', ')
                        FROM cargas_combustible_rutas ccr
                        JOIN rutas r ON ccr.id_ruta = r.id_ruta
                        WHERE ccr.id_carga = cc.id_carga
                    )
                    WHEN cc.tipo_calculo = 'dias' THEN COALESCE(
                        (SELECT r.nombre_ruta FROM rutas r WHERE r.id_ruta = cc.id_ruta_principal),
                        'Sin especificar'
                    )
                    ELSE '-'
                END as rutas_y_vueltas,
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

        // Agregamos la leyenda " (X días)" a las cargas que son por día
        const dataWithDays = dataResult.rows.map(row => {
            if (row.tipo_calculo === 'dias') {
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

// ============================================
// GET /detalle/:id 
// ============================================
router.get('/detalle/:id', [verifyToken, checkRole(['AdminDiesel', 'Almacenista', 'SuperUsuario', 'Admin'])], async (req, res) => {
    const { id } = req.params;

    try {
        // Query limpia sin caracteres invisibles
        const query = `
            SELECT 
                cc.id_carga,
                cc.fecha_operacion,
                cc.km_inicial,
                cc.km_final,
                cc.km_recorridos,
                cc.litros_cargados,
                cc.rendimiento_calculado,
                cc.tipo_calculo,
                cc.id_ruta_principal,
                cc.dias_laborados,
                cc.id_autobus,
                cc.id_empleado_operador,
                cc.desviacion_km,
                cc.km_esperados,
                cc.motivo_desviacion,
                cc.id_tanque,
                a.economico,
                o.nombre_completo as nombre_operador,
                d.nombre as nombre_despachador,
                t.nombre_tanque
            FROM cargas_combustible cc
            LEFT JOIN autobus a ON cc.id_autobus = a.id_autobus
            LEFT JOIN operadores o ON cc.id_empleado_operador = o.id_operador
            LEFT JOIN empleado d ON cc.id_empleado_despachador = d.id_empleado
            LEFT JOIN tanques_combustible t ON cc.id_tanque = t.id_tanque
            WHERE cc.id_carga = $1
        `;

        const result = await pool.query(query, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: 'Carga no encontrada',
                message: `No se encontró una carga con el ID ${id}` 
            });
        }

        const carga = result.rows[0];

        // Si es tipo 'vueltas', obtenemos las rutas
        if (carga.tipo_calculo === 'vueltas') {
            const rutasQuery = `
                SELECT ccr.id_ruta, ccr.numero_vueltas, r.nombre_ruta
                FROM cargas_combustible_rutas ccr
                JOIN rutas r ON ccr.id_ruta = r.id_ruta
                WHERE ccr.id_carga = $1
            `;
            const rutasResult = await pool.query(rutasQuery, [id]);
            carga.rutas_realizadas = rutasResult.rows;
            
            // Formatear string para info rápida
            if (rutasResult.rows.length > 0) {
                carga.rutas_info = rutasResult.rows.map(r => `${r.nombre_ruta} (${r.numero_vueltas} vueltas)`).join(', ');
            }
        } else if (carga.tipo_calculo === 'dias') {
            // Obtener nombre de la ruta principal si es por días
            if (carga.id_ruta_principal) {
                const rutaPrincipal = await pool.query('SELECT nombre_ruta FROM rutas WHERE id_ruta = $1', [carga.id_ruta_principal]);
                if (rutaPrincipal.rows.length > 0) {
                    carga.rutas_info = `${rutaPrincipal.rows[0].nombre_ruta} (${carga.dias_laborados} días)`;
                }
            }
        }

        res.json(carga);

    } catch (error) {
        console.error('❌ ERROR en /detalle/:id:', error);
        res.status(500).json({ 
            error: 'Error en el servidor',
            message: error.message
        });
    }
});

// ============================================
// PUT /:id - Actualizar carga
// ============================================
router.put('/:id', [verifyToken, checkRole(['AdminDiesel', 'Almacenista', 'SuperUsuario', 'Admin'])], async (req, res) => {
    const { id } = req.params;
    const { 
        fecha_operacion, 
        km_inicial, 
        km_final, 
        litros_cargados, 
        tipo_calculo,
        id_ruta_principal,
        dias_laborados,
        rutas_realizadas
    } = req.body;

    console.log('============================================');
    console.log('📝 PUT /:id - Iniciando actualización con ajuste de tanque...');
    console.log('ID:', id);
    console.log('Datos recibidos:', {
        fecha_operacion,
        km_inicial,
        km_final,
        litros_cargados,
        tipo_calculo
    });
    console.log('============================================');

    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        console.log('✅ Transacción iniciada');

        // ========== VALIDACIONES ==========
        console.log('🔍 Validando datos...');
        
        if (!fecha_operacion || km_inicial === undefined || km_final === undefined || litros_cargados === undefined) {
            console.log('❌ Datos incompletos');
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Datos incompletos',
                message: 'Se requieren: fecha_operacion, km_inicial, km_final, litros_cargados' 
            });
        }

        const kmInicialNum = parseFloat(km_inicial);
        const kmFinalNum = parseFloat(km_final);
        const litrosNum = parseFloat(litros_cargados);

        if (isNaN(kmInicialNum) || isNaN(kmFinalNum) || isNaN(litrosNum)) {
            console.log('❌ Valores no numéricos');
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Datos inválidos',
                message: 'Los valores numéricos no son válidos' 
            });
        }

        if (kmFinalNum <= kmInicialNum) {
            console.log('❌ KM Final debe ser mayor a KM Inicial');
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Kilometraje inválido',
                message: 'El kilometraje final debe ser mayor al kilometraje inicial' 
            });
        }

        if (litrosNum <= 0) {
            console.log('❌ Litros debe ser mayor a 0');
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: 'Litros inválidos',
                message: 'Los litros cargados deben ser mayor a 0' 
            });
        }

        console.log('✅ Validaciones pasadas');

        // ========== OBTENER DATOS ORIGINALES DE LA CARGA ==========
        console.log('🔍 Obteniendo datos originales de la carga...');
        const cargaOriginalResult = await client.query(
            `SELECT 
                id_autobus, 
                id_empleado_operador, 
                tipo_calculo,
                litros_cargados as litros_originales,
                id_tanque
            FROM cargas_combustible 
            WHERE id_carga = $1`,
            [id]
        );

        if (cargaOriginalResult.rows.length === 0) {
            console.log('❌ Carga no encontrada');
            await client.query('ROLLBACK');
            return res.status(404).json({ 
                error: 'Carga no encontrada',
                message: `No se encontró una carga con el ID ${id}` 
            });
        }

        const cargaOriginal = cargaOriginalResult.rows[0];
        const { id_autobus, id_empleado_operador, litros_originales, id_tanque } = cargaOriginal;
        
        console.log('✅ Carga encontrada:', {
            id_autobus,
            litros_originales,
            litros_nuevos: litrosNum,
            id_tanque
        });

        // ========== CALCULAR DIFERENCIA DE LITROS ==========
        const diferencia_litros = litrosNum - parseFloat(litros_originales);
        console.log('📊 Diferencia de litros:', diferencia_litros.toFixed(2));

        // ========== AJUSTAR NIVEL DEL TANQUE ==========
        if (diferencia_litros !== 0) {
            console.log('⛽ Ajustando nivel del tanque...');
            
            // Verificar que el tanque existe
            const tanqueResult = await client.query(
                'SELECT id_tanque, nivel_actual_litros, capacidad_litros FROM tanques_combustible WHERE id_tanque = $1',
                [id_tanque]
            );

            if (tanqueResult.rows.length === 0) {
                console.log('❌ Tanque no encontrado');
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    error: 'Tanque no encontrado',
                    message: 'No se encontró el tanque asociado a esta carga' 
                });
            }

            const tanque = tanqueResult.rows[0];
            const nivel_actual = parseFloat(tanque.nivel_actual_litros);
            const capacidad_litros = parseFloat(tanque.capacidad_litros);

            console.log('📊 Estado del tanque:', {
                id_tanque,
                nivel_actual,
                capacidad_litros
            });

            // Si se reducen los litros (diferencia negativa), devolver al tanque
            // Si se aumentan los litros (diferencia positiva), tomar del tanque
            const nuevo_nivel = nivel_actual - diferencia_litros;

            console.log('📊 Cálculo del nuevo nivel:', {
                nivel_actual,
                diferencia_litros,
                nuevo_nivel
            });

            // Validar que el tanque tenga suficiente combustible si se aumentan litros
            if (diferencia_litros > 0 && nuevo_nivel < 0) {
                console.log('❌ Tanque sin suficiente combustible');
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    error: 'Tanque insuficiente',
                    message: `El tanque solo tiene ${nivel_actual.toFixed(2)} litros disponibles. No se pueden cargar ${diferencia_litros.toFixed(2)} litros adicionales.` 
                });
            }

            // Validar que no se exceda la capacidad del tanque al devolver combustible
            if (diferencia_litros < 0 && nuevo_nivel > capacidad_litros) {
                console.log('⚠️ ADVERTENCIA: Devolver combustible excedería la capacidad del tanque');
                console.log(`Capacidad: ${capacidad_litros}L, Nuevo nivel calculado: ${nuevo_nivel}L`);
                console.log('Se ajustará al máximo de la capacidad');
                
                // Ajustar al máximo sin exceder
                const litros_ajustados = capacidad_litros - nivel_actual;
                
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    error: 'Capacidad del tanque excedida',
                    message: `No se pueden devolver ${Math.abs(diferencia_litros).toFixed(2)} litros al tanque. Solo hay espacio para ${litros_ajustados.toFixed(2)} litros adicionales. Capacidad del tanque: ${capacidad_litros}L, Nivel actual: ${nivel_actual.toFixed(2)}L` 
                });
            }

            // Actualizar el nivel del tanque
            await client.query(
                'UPDATE tanques_combustible SET nivel_actual_litros = $1 WHERE id_tanque = $2',
                [nuevo_nivel, id_tanque]
            );

            if (diferencia_litros < 0) {
                console.log(`✅ Devueltos ${Math.abs(diferencia_litros).toFixed(2)} litros al tanque`);
                console.log(`Nivel del tanque: ${nivel_actual.toFixed(2)}L → ${nuevo_nivel.toFixed(2)}L`);
            } else {
                console.log(`✅ Tomados ${diferencia_litros.toFixed(2)} litros adicionales del tanque`);
                console.log(`Nivel del tanque: ${nivel_actual.toFixed(2)}L → ${nuevo_nivel.toFixed(2)}L`);
            }
        } else {
            console.log('ℹ️ No hay cambios en los litros, no se ajusta el tanque');
        }

        // ========== CALCULAR KM ESPERADOS ==========
        console.log('📊 Calculando km esperados...');
        let km_esperados = 0;

        if (tipo_calculo === 'dias' && id_ruta_principal && dias_laborados > 0) {
            const rutaResult = await client.query(
                'SELECT kilometraje_vuelta, vueltas_diarias_promedio FROM rutas WHERE id_ruta = $1',
                [id_ruta_principal]
            );
            if (rutaResult.rows.length > 0) {
                const { kilometraje_vuelta, vueltas_diarias_promedio } = rutaResult.rows[0];
                km_esperados = dias_laborados * vueltas_diarias_promedio * kilometraje_vuelta;
                console.log('✅ KM esperados (días):', km_esperados);
            }
        } else if (tipo_calculo === 'vueltas' && rutas_realizadas && rutas_realizadas.length > 0) {
            const idsRutas = rutas_realizadas.map(r => r.id_ruta);
            const rutasResult = await client.query(
                'SELECT id_ruta, kilometraje_vuelta FROM rutas WHERE id_ruta = ANY($1::int[])',
                [idsRutas]
            );
            for (const rutaDetalle of rutas_realizadas) {
                const rutaInfo = rutasResult.rows.find(r => r.id_ruta === rutaDetalle.id_ruta);
                if (rutaInfo) {
                    km_esperados += rutaInfo.kilometraje_vuelta * rutaDetalle.vueltas;
                }
            }
            console.log('✅ KM esperados (vueltas):', km_esperados);
        }

        // ========== CALCULAR VALORES DERIVADOS ==========
        const km_recorridos = kmFinalNum - kmInicialNum;
        const rendimiento_calculado = km_recorridos / litrosNum;
        const desviacion_km = km_recorridos - km_esperados;

        console.log('📊 Cálculos realizados:', {
            km_recorridos,
            rendimiento_calculado: rendimiento_calculado.toFixed(2),
            desviacion_km: desviacion_km.toFixed(2)
        });

        // ========== ACTUALIZAR LA CARGA ==========
        console.log('💾 Actualizando registro de la carga...');
        const updateQuery = `
            UPDATE cargas_combustible 
            SET 
                fecha_operacion = $1,
                km_inicial = $2,
                km_final = $3,
                km_recorridos = $4,
                litros_cargados = $5,
                rendimiento_calculado = $6,
                km_esperados = $7,
                desviacion_km = $8,
                tipo_calculo = $9,
                id_ruta_principal = $10,
                dias_laborados = $11
            WHERE id_carga = $12
        `;

        await client.query(updateQuery, [
            fecha_operacion,
            kmInicialNum,
            kmFinalNum,
            km_recorridos,
            litrosNum,
            rendimiento_calculado,
            km_esperados,
            desviacion_km,
            tipo_calculo || 'vueltas',
            tipo_calculo === 'dias' ? id_ruta_principal : null,
            tipo_calculo === 'dias' ? dias_laborados : null,
            id
        ]);

        console.log('✅ Carga actualizada');

        // ========== ACTUALIZAR RUTAS (si es tipo vueltas) ==========
        if (tipo_calculo === 'vueltas' && rutas_realizadas) {
            console.log('🛣️ Actualizando rutas...');
            await client.query('DELETE FROM cargas_combustible_rutas WHERE id_carga = $1', [id]);
            
            for (const rutaDetalle of rutas_realizadas) {
                await client.query(
                    'INSERT INTO cargas_combustible_rutas (id_carga, id_ruta, numero_vueltas) VALUES ($1, $2, $3)',
                    [id, rutaDetalle.id_ruta, rutaDetalle.vueltas]
                );
            }
            console.log('✅ Rutas actualizadas');
        }

        // ========== REGISTRAR AUDITORÍA (OPCIONAL) ==========
        console.log('📝 Registrando auditoría...');
        try {
            await client.query(
                `INSERT INTO auditoria_cargas_combustible 
                (id_carga, id_empleado, accion, litros_anteriores, litros_nuevos, diferencia_litros, fecha_modificacion)
                VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [id, req.user.id, 'EDICION', litros_originales, litrosNum, diferencia_litros]
            );
            console.log('✅ Auditoría registrada');
        } catch (auditError) {
            // Si la tabla de auditoría no existe, solo lo reportamos pero no fallamos
            console.log('⚠️ No se pudo registrar auditoría (tabla puede no existir):', auditError.message);
        }

        await client.query('COMMIT');
        console.log('✅ Transacción confirmada exitosamente');

        // ========== OBTENER DATOS ACTUALIZADOS ==========
        console.log('📥 Obteniendo datos actualizados...');
        const datosActualizados = await pool.query(
            `SELECT 
                cc.*,
                a.economico,
                o.nombre_completo as nombre_operador,
                tc.nivel_actual_litros as nivel_tanque_actual
            FROM cargas_combustible cc
            LEFT JOIN autobus a ON cc.id_autobus = a.id_autobus
            LEFT JOIN operadores o ON cc.id_empleado_operador = o.id_operador
            LEFT JOIN tanques_combustible tc ON cc.id_tanque = tc.id_tanque
            WHERE cc.id_carga = $1`,
            [id]
        );

        console.log('✅ Actualización completada exitosamente');

        // Mensaje de respuesta con información del ajuste
        let mensajeAjuste = '';
        if (diferencia_litros < 0) {
            mensajeAjuste = ` Se devolvieron ${Math.abs(diferencia_litros).toFixed(2)} litros al tanque.`;
        } else if (diferencia_litros > 0) {
            mensajeAjuste = ` Se tomaron ${diferencia_litros.toFixed(2)} litros adicionales del tanque.`;
        }

        res.json({
            message: 'Carga actualizada y recalculada exitosamente.' + mensajeAjuste,
            data: datosActualizados.rows[0],
            cambios: {
                km_recorridos,
                rendimiento_calculado: rendimiento_calculado.toFixed(2),
                desviacion_km: desviacion_km.toFixed(2),
                litros_anteriores: parseFloat(litros_originales).toFixed(2),
                litros_nuevos: litrosNum.toFixed(2),
                diferencia_litros: diferencia_litros.toFixed(2),
                ajuste_tanque: diferencia_litros !== 0
            }
        });

    } catch (error) {
        await client.query('ROLLBACK');
        
        console.error('❌ ERROR en PUT /:id');
        console.error('Tipo:', error.constructor.name);
        console.error('Mensaje:', error.message);
        console.error('Stack:', error.stack);
        
        res.status(500).json({ 
            error: 'Error en el servidor',
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    } finally {
        client.release();
        console.log('🔌 Conexión liberada');
    }
});


// ============================================
// POST / - Registro de nueva carga 
// ============================================
router.post('/', [verifyToken, checkRole(['AdminDiesel', 'Almacenista', 'SuperUsuario', 'Admin'])], async (req, res) => {
    const {
        id_autobus, id_empleado_operador, id_ubicacion, fecha_operacion,
        km_final, litros_cargados, motivo_desviacion,
        tipo_calculo,
        id_ruta_principal,
        dias_laborados,
        rutas_realizadas
    } = req.body;
    const id_empleado_despachador = req.user.id;

    if (!id_autobus || !km_final || !litros_cargados || !fecha_operacion || !id_ubicacion) {
        return res.status(400).json({ message: 'Faltan datos requeridos.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const autobusResult = await client.query('SELECT kilometraje_ultima_carga, rendimiento_esperado FROM autobus WHERE id_autobus = $1 FOR UPDATE', [id_autobus]);
        if (autobusResult.rows.length === 0) throw new Error('Autobús no encontrado.');
        const { kilometraje_ultima_carga, rendimiento_esperado } = autobusResult.rows[0];
        const km_inicial = kilometraje_ultima_carga;
        if (km_final < km_inicial) throw new Error('El kilometraje final no puede ser menor que el de la última carga.');

        const tanquesDisponibles = await client.query(`SELECT id_tanque FROM tanques_combustible WHERE id_ubicacion = $1 AND nivel_actual_litros >= $2 ORDER BY nivel_actual_litros DESC LIMIT 1`, [id_ubicacion, litros_cargados]);
        if (tanquesDisponibles.rows.length === 0) throw new Error('No hay tanques con suficiente combustible en la ubicación seleccionada.');
        const id_tanque = tanquesDisponibles.rows[0].id_tanque;

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

        const km_recorridos = km_final - km_inicial;
        const desviacion_km = km_recorridos - km_esperados;
        const rendimiento_calculado = litros_cargados > 0 ? km_recorridos / litros_cargados : 0;
        const umbral_km = 15;
        const alerta_kilometraje = Math.abs(desviacion_km) > umbral_km;
        if (alerta_kilometraje && !motivo_desviacion) {
            throw new Error(`La desviación de ${desviacion_km.toFixed(2)} km es muy alta. Se requiere un motivo.`);
        }

        const cargaResult = await client.query(
            `INSERT INTO cargas_combustible (
                id_autobus, id_empleado_operador, id_empleado_despachador, id_tanque, fecha_operacion,
                km_inicial, km_final, km_recorridos, litros_cargados, rendimiento_calculado,
                km_esperados, desviacion_km, rendimiento_esperado, alerta_kilometraje, motivo_desviacion,
                id_ruta_principal, dias_laborados, tipo_calculo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
            [
                id_autobus, id_empleado_operador, id_empleado_despachador, id_tanque, fecha_operacion,
                km_inicial, km_final, km_recorridos, litros_cargados, rendimiento_calculado,
                km_esperados, desviacion_km, rendimiento_esperado, alerta_kilometraje, motivo_desviacion,
                tipo_calculo === 'dias' ? id_ruta_principal : null,
                tipo_calculo === 'dias' ? dias_laborados : null,
                tipo_calculo
            ]
        );
        const nuevaCarga = cargaResult.rows[0];

        if (tipo_calculo === 'vueltas' && rutas_realizadas) {
            for (const rutaDetalle of rutas_realizadas) {
                // CAMBIO 3: Usar la nueva variable
                await client.query(`INSERT INTO cargas_combustible_rutas (id_carga, id_ruta, numero_vueltas) VALUES ($1, $2, $3)`, [nuevaCarga.id_carga, rutaDetalle.id_ruta, rutaDetalle.vueltas]);
            }
        }

        await client.query('UPDATE autobus SET kilometraje_actual = $1, kilometraje_ultima_carga = $1 WHERE id_autobus = $2', [km_final, id_autobus]);
        await client.query('UPDATE tanques_combustible SET nivel_actual_litros = nivel_actual_litros - $1 WHERE id_tanque = $2', [litros_cargados, id_tanque]);

        await client.query('COMMIT');
        registrarAuditoria({
      id_usuario: req.user.id, // Lo sacamos del token verificado
      tipo_accion: 'CREAR',
      recurso_afectado: 'cargas_combustible',
      id_recurso_afectado: nuevaCarga.id_carga,
      detalles_cambio: { litros: nuevaCarga.litros_cargados, km: nuevaCarga.km_recorridos },
      ip_address: req.ip
    });
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