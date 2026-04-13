# benchlocal-registry

Official Bench Pack registry for BenchLocal.

This repository is the single source of truth for official Bench Packs that BenchLocal can install from the Settings screen.

## Files

- `registry.json`
  - Canonical public registry index used by BenchLocal.
- `server.mjs`
  - Local development server that validates `registry.json`, rebuilds local Bench Packs, and serves archive installs.

## Official Source Strategy

The public registry in `registry.json` points to the maintained GitHub `main` branches for the six official Bench Packs.

Once release tags exist, update each entry from `main` to a stable release tag such as `v1.0.0`.

The registry metadata should stay aligned with each pack's `benchlocal.pack.json`, especially:

- `id`
- `name`
- `author`
- `description`
- `version`
- `capabilities.tools`
- `capabilities.multiTurn`
- `capabilities.verification`

## Publishing

BenchLocal currently expects the registry at:

`https://raw.githubusercontent.com/stevibe/benchlocal-registry/main/registry.json`

If that URL changes, update the BenchLocal registry URL in `~/.benchlocal/config.toml`.

## Local Testing

This repository can also run a local registry server for private testing before the registry is published publicly.

The local server:

- validates each registry entry against the local `benchlocal.pack.json`
- rebuilds local Bench Packs through `npm run build:benchlocal`
- serves a local archive-backed registry at `http://127.0.0.1:4545/registry.json`
- serves Bench Pack archives from the sibling repositories under `../`

That lets BenchLocal install packs without publishing them first.

Commands:

```bash
npm run validate
npm run dev
```
