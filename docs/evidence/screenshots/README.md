# Screenshots: what is real and what is a mock

Rule from the project: never present a target, a mock or a fixture as a measured result. Every screenshot here is evidence of how a screen **looks and behaves**. None of them is evidence of hospital performance.

## Two kinds of source

| Prefix | Source | What the data is |
| --- | --- | --- |
| `e2e-*` | `tests/e2e/full-visit.spec.ts`, **real stack** | Freshly seeded PostgreSQL, the built API and the Vite dev server. Nothing mocked. The flow is book, check in, call, start, complete. |
| `w3-admin-reports-1440` | `apps/web/e2e-real/reports.spec.ts` (`pnpm --filter @hqms/web e2e:real`), **real stack** | The same real stack (`tests/e2e/stack.ts`, used read-only). The spec runs five walk-in visits through the API, in real time, then photographs the admin report. The Measured rows therefore come from five real visits: waits are seconds (shown as 0.0 min) and every sample size is 5 or less. That is what the screen shows for a very small real sample. |
| `w0-*`, `w1-*`, `w2-*`, `w3-*` (except the report above), `w4-*` | `apps/web/e2e/*.spec.ts`, **mock-backed** | The real web app talking to a Playwright route mock of the API (fixed clock 11 Nov 2026, 10:05 am IST). Names, tokens, counts and times are test fixtures. They check layout, states, wording and keyboard paths, not numbers. |

The mock-backed reports test (`w3-admin.spec.ts`, "reports: every metric is labelled Measured or Target") still asserts the labels and the "Not enough data" cases but takes **no screenshot**, because its figures (for example 214 completed visits) are fixtures and must not appear in evidence as Measured.

## Reading a mock-backed shot

- Capacity, queue lanes, pressure notes ("Workload: High") and ETA ranges are whatever the fixture says. The pressure reasons in `w4-*` are example sentences for layout, not output of the pressure calculation.

## Regenerating

- Mock-backed: `pnpm --filter @hqms/web screenshots` (Playwright, `--trace off`).
- Real-stack web shot: `pnpm --filter @hqms/web e2e:real`.
- Real-stack full visit: `pnpm e2e`.
