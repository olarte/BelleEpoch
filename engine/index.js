// engine/index.js — Entry point for Belle Epoch clearing engine + API
//
// Usage:
//   node index.js          — starts Express API + clearing engine
//   node --watch index.js  — development mode with auto-reload

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

// Re-export clearing engine for backward compatibility
module.exports = require('./clearing');

// Start the full stack when run directly
if (require.main === module) {
  require('./api');
}
