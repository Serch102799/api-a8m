const pool = require('./db');

async function getColumns(tableName) {
  const result = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tableName}'`);
  console.log(`Table: ${tableName}`);
  console.log(result.rows);
}

async function run() {
  await getColumns('entrada_almacen');
  await getColumns('salida_almacen');
  await getColumns('detalle_entrada');
  await getColumns('detalle_salida');
  process.exit();
}
run();
