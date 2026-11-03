// Compatibility entry point for deployments that start the worker from the
// repository root instead of configuring synergy-backend as the root directory.
const path = require('node:path');

process.chdir(path.join(__dirname, 'synergy-backend'));
require('./synergy-backend/worker.js');
