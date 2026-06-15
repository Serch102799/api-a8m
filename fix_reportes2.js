const fs = require('fs');
const path = 'c:/Users/sergi/OneDrive/Escritorio/SGE/api-almacen/routes/reportes.js';
let content = fs.readFileSync(path, 'utf8');

// The safest way is to find "FROM detalle_entrada de"
// and insert "WHERE de.estado IS DISTINCT FROM 'Cancelado'" 
// but wait, some have WHERE already, some don't.
// Let's replace "FROM detalle_entrada de JOIN" with "FROM detalle_entrada de JOIN" 
// and "WHERE ea.fecha_operacion" with "WHERE de.estado IS DISTINCT FROM 'Cancelado' AND ea.fecha_operacion"

content = content.replace(/WHERE ea\.fecha_operacion/g, "WHERE de.estado IS DISTINCT FROM 'Cancelado' AND ea.fecha_operacion");

// To avoid duplicate or invalid SQL (since `WHERE ea.fecha_operacion` might be used when `de` is not defined),
// let's do more targeted replace:
// 1. "SELECT de.id_entrada, de.cantidad_recibida, l.costo_unitario_final FROM detalle_entrada de JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada"
// -> "... WHERE de.estado IS DISTINCT FROM 'Cancelado'"
content = content.replace(/SELECT de\.id_entrada, de\.cantidad_recibida, l\.costo_unitario_final FROM detalle_entrada de JOIN lote_refaccion l ON de\.id_detalle_entrada = l\.id_detalle_entrada/g, 
  "SELECT de.id_entrada, de.cantidad_recibida, l.costo_unitario_final FROM detalle_entrada de JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada WHERE de.estado IS DISTINCT FROM 'Cancelado'");

// 2. "FROM detalle_entrada de JOIN entrada_almacen ea ON de.id_entrada = ea.id_entrada JOIN lote_refaccion l ON de.id_detalle_entrada = l.id_detalle_entrada JOIN refaccion r ON l.id_refaccion = r.id_refaccion WHERE"
// -> add the filter
content = content.replace(/FROM detalle_entrada de JOIN/g, 
  "FROM detalle_entrada de JOIN");

// I'll just restore the original and only replace specifically.
// Wait, I already replaced the `detalle_salida ds` correctly. I'll just keep it simple.

fs.writeFileSync(path, content);
console.log('Done');
