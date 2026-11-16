# Contributing

Thanks for looking. The repo is five independent packages under `packages/` (no root install: each has its own lockfile).

```bash
npm run install:all   # npm ci in every package, in dependency order
npm run typecheck
npm test
npm run build         # builds the web UI
```

Rules of the road:

- TypeScript, strict, ESM, Node 22 or newer.
- Behaviour in `packages/core` and `packages/server` is pinned by golden tests generated from the Python reference implementation
  (`packages/core/scripts/gen-golden.py`). If you change behaviour on purpose, regenerate or edit the golden file in the same commit and say why.
- Add a test with every bug fix. Keep tests deterministic and offline: use the fake model and fake Drive from `@intake/core`.
- Use synthetic data only (names are made up, emails end in `@example.com`, phones are in the reserved `+44 7700 900xxx` range).
  Never commit keys, tokens, `.env` files or real résumés.
- Small, focused commits; run typecheck and tests before pushing.
