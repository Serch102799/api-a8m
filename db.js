const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'almacen',
  password: 'Carrillo10',
  port: 5432, 
});

module.exports = pool;
