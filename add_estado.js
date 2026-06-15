const pool = require('./db');

async function runMigration() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    console.log('Adding estado column to detalle_entrada...');
    await client.query(`
      ALTER TABLE detalle_entrada 
      ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'Activo';
    `);

    console.log('Adding estado column to detalle_salida...');
    await client.query(`
      ALTER TABLE detalle_salida 
      ADD COLUMN IF NOT EXISTS estado VARCHAR(20) DEFAULT 'Activo';
    `);

    await client.query('COMMIT');
    console.log('Migration completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error during migration:', err);
  } finally {
    client.release();
    pool.end();
  }
}

runMigration();
