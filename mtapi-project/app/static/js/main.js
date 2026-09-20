// ES module entry — imports the monolithic app.js and boots it.
// Future module splits will import individual pieces from here.

import '/app.js';
import { HelpStrip } from '/js/ui/help-strip.js';

// Boot: ES modules are deferred, so DOM is already parsed.
// Call init directly instead of relying on DOMContentLoaded.
window.addEventListener('DOMContentLoaded', () => {
  // Just in case, but app.js already has this listener.
});

// Help strip: delegated hover-help bar at the bottom of <main>.
// Fails silently if the #help-strip element is absent.
HelpStrip.init();
