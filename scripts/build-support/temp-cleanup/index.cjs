const fs = require('node:fs');

// This private adapter serves temp's literal paths, including names with glob
// characters. It does not implement rimraf's general glob expansion API.
function cleanupOptions({ maxBusyTries = 3 } = {}) {
  return { recursive: true, force: true, maxRetries: maxBusyTries, retryDelay: 100 };
}

function cleanup(target, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }
  fs.rm(target, cleanupOptions(options), callback);
}

cleanup.sync = function cleanupSync(target, options) {
  fs.rmSync(target, cleanupOptions(options));
};

module.exports = cleanup;
