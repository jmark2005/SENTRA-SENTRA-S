'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DB_PATH = process.env.DB_PATH || './db/sentra.db';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

module.exports = { PORT, DB_PATH, COOKIE_SECURE, SESSION_SECRET };
