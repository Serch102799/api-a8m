const express = require('express');
const pool = require('../db');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');

router.use(verifyToken);

router.get('/', async (req, res) => {
  try {
    // 1. OBTENER KPIs DE OPERADORES (Corregido a tabla "operadores")
    const kpisQuery = `
      SELECT 
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true) as operadores_activos,
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true AND licencia_vencimiento < CURRENT_DATE) as licencias_vencidas,
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true AND licencia_vencimiento >= CURRENT_DATE AND licencia_vencimiento <= CURRENT_DATE + INTERVAL '30 days') as licencias_por_vencer,
        (SELECT COUNT(*) FROM operadores WHERE esta_activo = true AND licencia_vencimiento IS NULL) as sin_licencia
    `;
    
    // 2. CALCULAR RENDIMIENTO MENSUAL (Directo en SQL)
    const rendimientoQuery = `
      WITH RendimientoOperador AS (
        SELECT 
          c.id_empleado_operador,
          o.nombre_completo as operador,
          MAX(a.economico) as autobus_frecuente, -- Toma el camión más usado por este chofer
          SUM(c.litros_cargados) as total_litros,
          -- Sumamos el recorrido (si ya tienes km_recorridos lo usamos, si no, restamos final menos inicial)
          SUM(COALESCE(c.km_recorridos, (c.km_final - c.km_inicial), 0)) as total_km
        FROM cargas_combustible c
        JOIN operadores o ON c.id_empleado_operador = o.id_operador
        LEFT JOIN autobus a ON c.id_autobus = a.id_autobus
        -- Filtramos solo los últimos 30 días y operadores activos
        WHERE c.fecha_operacion >= CURRENT_DATE - INTERVAL '30 days'
          AND o.esta_activo = true
        GROUP BY c.id_empleado_operador, o.nombre_completo
        -- Filtramos para que no salgan datos basura (ej. alguien que cargó 0 litros)
        HAVING SUM(c.litros_cargados) > 0 
      )
      -- Ahora hacemos la división matemática final
      SELECT 
        *,
        (total_km / total_litros) as rendimiento_promedio
      FROM RendimientoOperador
      WHERE total_litros >= 50 -- Exigimos al menos 50 Litros en el mes para ser considerado en el Top 10
    `;

    const [kpisResult, rendimientoResult] = await Promise.all([
      pool.query(kpisQuery),
      pool.query(rendimientoQuery)
    ]);

    // Parseamos a Float para evitar que Node lo trate como texto
    const rendimientos = rendimientoResult.rows.map(r => ({
      ...r,
      rendimiento_promedio: parseFloat(r.rendimiento_promedio)
    }));

    // Ordenamos la misma lista de 2 formas diferentes (Mayor a menor, y menor a mayor)
    const topMejores = [...rendimientos].sort((a, b) => b.rendimiento_promedio - a.rendimiento_promedio).slice(0, 10);
    const topPeores = [...rendimientos].sort((a, b) => a.rendimiento_promedio - b.rendimiento_promedio).slice(0, 10);

    res.json({
      kpis: kpisResult.rows[0],
      topMejores,
      topPeores
    });

  } catch (error) {
    console.error('Error en Dashboard RRHH:', error);
    res.status(500).json({ message: 'Error al cargar el dashboard de RRHH' });
  }
});

module.exports = router;