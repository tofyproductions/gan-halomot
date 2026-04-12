require('dotenv').config();

const path = require('path');

const baseConfig = {
  client: 'pg',
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('neon.tech') ? { rejectUnauthorized: false } : false,
  },
  migrations: { directory: path.join(__dirname, 'migrations') },
  seeds: { directory: path.join(__dirname, 'seeds') },
};

module.exports = {
  development: { ...baseConfig },
  production: {
    ...baseConfig,
    pool: { min: 1, max: 5 },
  },
};
