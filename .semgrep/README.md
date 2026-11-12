# Semgrep

`pnpm semgrep` runs the registry packs `p/typescript` and `p/owasp-top-ten` with `--error` (any finding fails the build).
The registry is fetched at scan time through the proxy. If it is ever unreachable, add a vendored ruleset here
(`.semgrep/rules.yml`) and run `semgrep scan --config .semgrep/rules.yml --error` instead. No vendored fallback is
needed today because the registry scan works.

Project-specific rules belong in `.semgrep/local-rules.yml` and are added with an extra `--config` flag.
`.semgrepignore` excludes build output, test files and fixtures.
