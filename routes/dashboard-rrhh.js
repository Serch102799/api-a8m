const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, id_ruta } = req.query;

    // 1. KPIs de Licencias (Estos se mantienen globales o según necesites)
    const kpisQuery = `
      SELECT 
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true) as operadores_activos,
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true AND licencia_vencimiento < CURRENT_DATE) as licencias_vencidas,
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true AND licencia_vencimiento >= CURRENT_DATE AND licencia_vencimiento <= CURRENT_DATE + INTERVAL '30 days') as licencias_por_vencer,
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true AND licencia_vencimiento IS NULL) as sin_licencia
    `;

    // 2. Lógica de Filtros para Rendimiento
    let params = [];
    let filterConditions = `WHERE o.esta_activo = true`;

    // Filtro de Fechas (Default: últimos 7 días)
    if (fecha_desde && fecha_hasta) {
        params.push(fecha_desde, fecha_hasta);
        filterConditions += ` AND c.fecha_operacion >= $1 AND c.fecha_operacion <= $2`;
    } else {
        filterConditions += ` AND c.fecha_operacion >= CURRENT_DATE - INTERVAL '7 days'`;
    }

    // Filtro de Ruta - CORREGIDO: Usando el alias 'c' correctamente
    if (id_ruta) {
        const rutaParamIndex = params.length + 1;
        params.push(id_ruta);
        filterConditions += ` AND (
            c.id_ruta_principal = $${rutaParamIndex} 
            OR c.id_carga IN (
                SELECT id_carga 
                FROM cargas_combustible_rutas 
                WHERE id_ruta =$${rutaParamIndex}
            )
        )`;
    }

    const rendimientoQuery = `
      WITH RendimientoOperador AS (
        SELECT 
          o.nombre_completo as operador,
          MAX(a.economico) as autobus_frecuente,
          SUM(c.litros_cargados) as total_litros,
          SUM(COALESCE(c.km_recorridos, (c.km_final - c.km_inicial), 0)) as total_km
        FROM cargas_combustible c
        JOIN operadores o ON c.id_empleado_operador = o.id_operador
        LEFT JOIN autobus a ON c.id_autobus = a.id_autobus
        ${filterConditions}
        GROUP BY o.nombre_completo
        HAVING SUM(c.litros_cargados) > 0 
      )
      SELECT *, 
             CASE 
                WHEN total_litros > 0 THEN (total_km / total_litros) 
                ELSE 0 
             END as rendimiento_promedio
      FROM RendimientoOperador
      WHERE total_litros > 0
    `;

    const [kpis, rendimiento] = await Promise.all([
      pool.query(kpisQuery),
      pool.query(rendimientoQuery, params)
    ]);

    const rendimientos = rendimiento.rows.map(r => ({
      ...r,
      rendimiento_promedio: parseFloat(r.rendimiento_promedio)
    }));

    const topMejores = [...rendimientos].sort((a, b) => b.rendimiento_promedio - a.rendimiento_promedio).slice(0, 10);
    const topPeores = [...rendimientos].sort((a, b) => a.rendimiento_promedio - b.rendimiento_promedio).slice(0, 10);

    res.json({
      kpis: kpis.rows[0],
      topMejores,
      topPeores
    });

  } catch (error) {
    console.error('Error en Dashboard RRHH:', error);
    res.status(500).json({ message: 'Error al cargar el dashboard' });
  }
});

module.exports = router;