// Served from the page's own origin (serve.js serveLandingScript): helmet's CSP allows script-src 'self' only.
// It only tidies the page for the device in hand; it never redirects (the old Expo Go auto-open is gone).
(function () {
  var ua = navigator.userAgent;
  var isIOS =
    /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var isAndroid = /Android/i.test(ua);

  function hide(id) {
    var el = document.getElementById(id);
    if (el) el.hidden = true;
  }

  if (isIOS) {
    hide("android-card");
    hide("qr-card");
  } else if (isAndroid) {
    hide("ios-card");
    hide("qr-card");
  }
})();
