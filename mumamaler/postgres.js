const { Pool } = require('pg');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

module.exports = new Pool({ connectionString: process.env.DATABASE_URL });
