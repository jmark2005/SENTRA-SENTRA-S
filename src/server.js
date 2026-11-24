'use strict';

const http = require('http');
const app = require('./app');
const { PORT } = require('./config');

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`SENTRA server running on http://localhost:${PORT}`);
});

module.exports = server;
