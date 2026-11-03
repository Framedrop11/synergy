// Keep the existing Render root-level `npm start` command working while the
// backend implementation lives under ./synergy-backend.
const path = require('node:path');

process.chdir(path.join(__dirname, 'synergy-backend'));
require('./synergy-backend/app.js');
