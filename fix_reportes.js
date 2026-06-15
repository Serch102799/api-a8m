const fs = require('fs');
const path = 'c:/Users/sergi/OneDrive/Escritorio/SGE/api-almacen/routes/reportes.js';
let content = fs.readFileSync(path, 'utf8');

// Replace ds.cantidad_despachada checks
content = content.replace(/\(ds\.cantidad_despachada - COALESCE\(ds\.cantidad_devuelta, 0\)\) > 0/g, "(ds.cantidad_despachada - COALESCE(ds.cantidad_devuelta, 0)) > 0 AND ds.estado IS DISTINCT FROM 'Cancelado'");

fs.writeFileSync(path, content);
console.log('Replacements done in reportes.js');
