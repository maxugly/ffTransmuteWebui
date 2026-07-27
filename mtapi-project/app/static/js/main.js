// ES module entry — imports the monolithic app.js and boots it.
// Future module splits will import individual pieces from here.

import '/app.js';

// Boot: ES modules are deferred, so DOM is already parsed.
// Call init directly instead of relying on DOMContentLoaded.
window.addEventListener('DOMContentLoaded', () => {
  // Just in case, but app.js already has this listener.
});
