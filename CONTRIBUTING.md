# Contributing

Use Node 22 or newer. Keep tests and examples synthetic. Before opening a pull request, run `npm run lint`, `npm run typecheck`, `npm test`, `npm run evals`, `npm run build`, `npm audit --omit=dev`, and `npm run secret-scan`.

Each new tool needs a Zod input schema, a validated `data` plus `examined` result, a bounded query, redaction coverage, and a replay test. Do not add account names, hostnames, emails, tokens, or real provider responses to tests or documentation.
