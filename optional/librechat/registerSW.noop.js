// Disable the bundled PWA service worker for local stack stability.
// The shipped sw.js references a non-precached index.html in this build,
// which can break auth/preview flows after cache updates.
(() => {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      registrations.forEach((registration) => {
        registration.unregister();
      });
    })
    .catch(() => {});
})();
