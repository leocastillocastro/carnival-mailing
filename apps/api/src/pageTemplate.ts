// Shared by every plain-HTML page apps/api serves directly to a browser
// (unsubscribe confirmations, the 404 fallback) — this app is otherwise all
// webhooks/JSON, so there's no bigger layout system worth building for a
// handful of one-off pages.
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222;line-height:1.5;text-align:center;}
a{color:#b3441e;}
button{font:inherit;background:#b3441e;color:#fff;border:none;padding:0.7rem 1.5rem;border-radius:0.25rem;cursor:pointer;}
</style>
</head>
<body><h1>${title}</h1>${body}</body>
</html>`;
}
