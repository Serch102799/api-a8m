const { Pool } = require('pg');
require('dotenv').config();

const config = {
  connectionString: process.env.DATABASE_URL,
};

// Se añade SSL solo si estamos en el entorno de producción
if (process.env.NODE_ENV === 'production') {
  config.ssl = {
    rejectUnauthorized: false
  };
}

const pool = new Pool(config);

module.exports = pool;