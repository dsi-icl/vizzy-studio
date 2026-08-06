# Why the unit suite resolves `production` conditions

`lexicalHtml.test.ts` loads the `@lexical/*` module graph. Their **development**
builds contain circular imports that Bun cannot initialise, producing errors
like:

```
ReferenceError: Cannot access 'getStyleObjectFromCSS$1' before initialization
    at node_modules/@lexical/selection/dist/LexicalSelection.dev.mjs
ReferenceError: Cannot access 'IS_FIREFOX' before initialization
    at node_modules/@lexical/utils/dist/LexicalUtils.dev.mjs
```

This is **platform dependent**: it reproduces on Linux and passes on Windows, so
it surfaces in CI while a local run looks clean. To reproduce a CI failure
locally:

```sh
docker run --rm -v "$PWD:/app" -w /app oven/bun:latest \
  bun test apps/web/src/server/yjs/lexicalHtml.test.ts
```

`test:unit` therefore passes `--conditions=production`, which resolves the
production builds of those packages. Reordering imports does not help — it only
moves the failure to the next package in the cycle.

`--conditions` was chosen over `NODE_ENV=production` deliberately: it changes
module resolution only, leaving `process.env.NODE_ENV` alone. Setting NODE_ENV
would flip real runtime branches, notably the referrer check in
`routes/api/proxy.ts` and the secure-cookie decision in `server/wallMediaCookie.ts`.
