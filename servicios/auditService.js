const pool = require('../db'); // Ajusta la ruta a tu BD

/**
 * Registra una acción de auditoría en la base de datos.
 * Esta función se ejecuta "sin esperar" (fire-and-forget)
 * para no retrasar la respuesta al usuario.
 * * @param {Object} datosAccion
 * @param {number} datosAccion.id_usuario - ID del usuario que actúa (de req.user.id)
 * @param {string} datosAccion.tipo_accion - Ej: 'CREAR', 'ACTUALIZAR', 'ELIMINAR'
 * @param {string} datosAccion.recurso_afectado - Ej: 'cargas_combustible'
 * @param {number} [datosAccion.id_recurso_afectado] - ID del registro afectado (ej. id_carga)
 * @param {Object} [datosAccion.detalles_cambio] - JSON con los detalles
 * @param {string} [datosAccion.ip_address] - IP del usuario (de req.ip)
 */
const registrarAuditoria = (datosAccion) => {
  const {
    id_usuario,
    tipo_accion,
    recurso_afectado,
    id_recurso_afectado = null,
    detalles_cambio = null,
    ip_address = null
  } = datosAccion;

  const query = `
    INSERT INTO auditoria_acciones 
      (id_usuario, tipo_accion, recurso_afectado, id_recurso_afectado, detalles_cambio, ip_address)
    VALUES 
      ($1, $2, $3, $4, $5, $6)
  `;
  
  // Ejecutamos la consulta pero no usamos 'await'
  // Esto es "fire and forget". No queremos que el usuario
  // espere a que el log de auditoría se escriba.
  pool.query(query, [
    id_usuario,
    tipo_accion,
    recurso_afectado,
    id_recurso_afectado,
    detalles_cambio ? JSON.stringify(detalles_cambio) : null,
    ip_address
  ]).catch(err => {
    // Si falla el log de auditoría, no detenemos la app,
    // solo lo registramos en la consola del servidor.
    console.error('Error al registrar auditoría:', err.message);
  });
};

module.exports = { registrarAuditoria };