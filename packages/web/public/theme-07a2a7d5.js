/* global document, localStorage, window */
// The theme, set before first paint so that a dark-theme reader never sees a white flash.
//
// **A file, not a script inline in index.html** (`U-23`). ms-core serves the page under a
// Content-Security-Policy that refuses inline script, so the inline copy never ran there: every
// page the core served opened light, whatever the operating system asked for and whatever the
// reader had chosen. Only the Vite dev server, which sends no policy, ever ran it. A classic
// script in the head still holds the first paint until it has run, as the inline one did.
//
// **Its name carries a hash of what is in it**, because ms-core tells a browser to keep every file
// beside index.html for a year. Change a byte and the name changes with it; `theme-boot.test.ts`
// says what the new name is, and fails until it is the one on disk and in index.html.
(function () {
  try {
    const stored = localStorage.getItem('ms-theme');
    const dark =
      stored === 'dark' ||
      (stored !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
