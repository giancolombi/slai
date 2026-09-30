// Apply the saved theme before first paint to avoid a flash. A file, not an
// inline script, so the Content-Security-Policy can forbid inline scripts.
try {
  const saved = localStorage.getItem("slai-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {}
