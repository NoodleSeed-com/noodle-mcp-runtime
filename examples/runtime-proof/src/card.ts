// Static HTML is kept in a sibling TypeScript module so the public CLI can load
// it from its isolated authoring directory without relying on the caller's cwd.
export const cardHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Runtime proof card</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 1rem; }
    main { max-width: 32rem; padding: 1rem; border: 1px solid #888; border-radius: 0.75rem; }
    h1 { margin: 0 0 0.75rem; font-size: 1.25rem; }
    p { margin: 0.75rem 0 0; line-height: 1.5; overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>Synthetic deployment proof</h1>
    <p>This static card verifies that the runtime can return an MCP App resource.</p>
    <p>The greeting is synthetic. No model or external service is called by the proof tool.</p>
    <p>The packaged one-pixel branding image has its own asset URL. Fetch that URL separately
       to check asset storage; this card alone does not prove asset persistence.</p>
  </main>
</body>
</html>`;
