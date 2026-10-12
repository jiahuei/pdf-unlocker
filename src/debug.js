"use strict";
// Opt-in debugging for the tool pages. A blocked or slow console CDN must never affect normal use,
// so failure is ignored rather than reported.
try {
  if (
    new URL(location.href).searchParams.get("eruda") === "true" ||
    localStorage.getItem("active-eruda") === "true"
  ) {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/eruda@3.4.3/eruda.js";
    script.onload = () => window.eruda.init();
    document.head.append(script);
  }
} catch (error) {
  /* Storage may be unavailable in private browsing. */
}
