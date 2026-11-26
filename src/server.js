'use strict';

const http = require('http');
const app = require('./app');
const { PORT } = require('./config');

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`SENTRA server running on http://localhost:${PORT}`);
  // Follow-up reminders and overdue notices (T-26)
  require('./jobs/reminders.job').start();
  // Escalation job (T-37)
  require('./jobs/escalation.job').start();
});

module.exports = server;
