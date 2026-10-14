# Developing the node

```sh
npm install
npm run lint   # n8n-node lint
npm run format:check  # Prettier, with the repo's .prettierrc.js (npm run format writes)
npm run build  # n8n-node build
npm test       # the plain-function suite, then the engine suite
npm run check:package  # after a build: what `npm pack` would ship
npm run dev    # n8n-node dev: a local n8n on http://localhost:5678 with the node loaded
```

## Against a local SourceToDocs API

Point the credential's **Base URL** at it. Besides `https`, the node accepts plain `http` only for
`localhost`, `127.0.0.1` and `[::1]`, because every request carries the token.

`npm run dev` runs n8n on this machine, so a local API is `http://127.0.0.1:<port>/api/public/v1`.
An n8n running in Docker cannot use `http://host.docker.internal:<port>/...`: that address is
refused, on purpose. Give the n8n container an `https` address for the API instead: a tunnel to
the local port (for example `cloudflared tunnel --url http://127.0.0.1:<port>`), or a local
reverse proxy with a certificate the container trusts. Test in the credential dialog does not
apply the rule, so it can pass where the node's own requests are refused.

## Tests and the package

`npm test` runs two layers: `vitest` on the plain functions, then `test-engine/`, which
runs the built node in n8n's own engine against a fake API (`npm --prefix test-engine ci` once).
The published package holds only `dist/nodes`, `dist/credentials`, `package.json`, `README.md`,
`LICENSE` and `CHANGELOG.md`; `npm run check:package` (also in CI and the release workflow)
fails if `npm pack` would list anything else.

## Releases

A release is a pushed `vX.Y.Z` tag matching `version` in `package.json`:
`.github/workflows/release.yml` builds, lints, tests and publishes to npm with provenance.
`npm publish` from a laptop is refused on purpose.
