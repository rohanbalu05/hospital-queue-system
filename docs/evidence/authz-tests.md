# NFR-06 authorization suite

Evidence for NFR-06 (a patient can never read another patient's data; roles and assignments are enforced server-side
on every route) and the authorization half of Table 5. Numbers marked **measured** come from the run described below.
The target is stated separately and is not a result.

|                                                 | Value                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Target                                          | 0 unauthorized successes, 0 side effects from refused requests                                                                    |
| **Measured** (repeated runs, identical results) | **0** unauthorized successes out of 100 requests that had to be refused; 0 refused requests changed the database; 0 failed checks |

## What was run

`pnpm --filter @hqms/tests test` runs `tests/integration/authz.test.ts` (11 tests: 10 passed, 1 skipped, see below).
It uses real HTTP against the built API (`apps/api/dist/main.js`) and the real PostgreSQL scratch database
`hqms_test_blackbox` (same harness and machine as `docs/evidence/T1-booking-collision.md`: 4 vCPU cloud VM,
Node v22.23.4, PostgreSQL 16.15 on localhost). Logins use the seeded demo accounts over `POST /auth/login`. Nothing is
mocked. Raw per-request results: `docs/evidence/authz-tests.raw.json` (every request, actor, status, side-effect flag).

Zero side effects is checked per request: before and after each request the test takes a fingerprint of the database
(md5 over the full rows of `appointments`, `capacity_allocations`, `session_capacity`, `visits`, `queue_entries`,
`patients` and `sessions`, plus row counts of `outbox_events`, `jobs`, `idempotency_records` and the audit rows of
state-changing operations; login and search audit rows are excluded). The two fingerprints must be equal.

## Counts (measured)

| Category                                                                        |  Checks |                                                Of which must be refused | Unauthorized successes | Requests that changed the DB |
| ------------------------------------------------------------------------------- | ------: | ----------------------------------------------------------------------: | ---------------------: | ---------------------------: |
| Cross-patient (patient@ against patient2, and patient2@ against patient@)       |      25 |                                                                      19 |                      0 |                            0 |
| Role matrix (18 routes x 6 roles, plus 6 named staff routes tried by a patient) |     114 | 32 refused, 82 permitted-role requests that must not be 401, 403 or 5xx |                      0 |                            0 |
| Assignment scope (reception3, doctor@)                                          |      15 |                                                                      13 |                      0 |                            0 |
| Unauthenticated (18 routes, no cookie and forged cookie)                        |      36 |                                                                      36 |                      0 |                            0 |
| Positive controls (own data and in-scope staff must still work)                 |       9 |                                                                       0 |                    n/a |                            0 |
| **Total executed**                                                              | **199** |                                                                 **100** |                  **0** |                        **0** |

One further check was skipped, not passed: `GET /sessions/{id}/queue` does not exist in this build (the route table
derived from the controllers has no such route), so the "session where only patient2 has an entry" case is recorded as
skipped. The test enables itself automatically when the route appears.

## Cross-patient paths (patient@ = Ramesh Kumar, patient2@ = Sunita Devi)

Each row was attempted in both directions (patient@ against patient2's resource, and patient2@ against patient@'s).
Expected 403 or 404; the build answers 404 (no existence disclosure) except where the role guard answers first.

| Attempt                                                         | Status (both directions) |
| --------------------------------------------------------------- | ------------------------ |
| `GET /appointments/{other's appointment}`                       | 404                      |
| `GET /appointments/{OTHER'S APPOINTMENT IN UPPER CASE}`         | 404                      |
| `GET /appointments?patientId={other}`                           | 404                      |
| `GET /appointments?patientId={other}&sessionId={own session}`   | 404                      |
| `GET /patients/{other}`                                         | 404                      |
| `POST /appointments/{other's}/cancel`                           | 404                      |
| `POST /appointments/{other's}/reschedule` (into a free session) | 404                      |
| `POST /appointments/{other's}/check-in` (staff route)           | 403                      |
| `POST /appointments` with `patientId` of the other patient      | 404                      |

Additional measured checks: a patient's `GET /appointments` (with and without `sessionId`) returned only their own rows in all four
list calls; a foreign appointment (and a foreign patient record) answers with exactly the same status, error code and
message as a nonexistent id.

## Role matrix (derived from the Nest controllers, measured)

The route table is not hand-maintained: `tests/support/routes.ts` reads every `*.controller.ts`, extracting the
controller prefix, HTTP method, path, `@Roles(...)` and `@Public()`. A newly added route is therefore in the matrix
automatically, and the test asserts that the public set is exactly `GET /health`, `POST /auth/login` and
`POST /auth/logout`. Requests carry an empty body and an id that matches no row, so they fail validation or lookup
without doing work.

Cell = HTTP status. "refused" is a role that is not in the route's `@Roles` and had to get 403. "permitted" is a role
that is in `@Roles`; the status there is only the result of the dummy request (400 validation, 404 unknown id, 200 for
lists) and the test asserts it is not 401, 403 or 5xx, i.e. the guard let the role through. `reception3` is
reception assigned to doctors 3 and 4 only.

| Route                               | patient       | reception     | reception3    | doctor        | followup      | admin         | no cookie | forged cookie |
| ----------------------------------- | ------------- | ------------- | ------------- | ------------- | ------------- | ------------- | --------- | ------------- |
| `POST /appointments/:id/cancel`     | 404 permitted | 404 permitted | 404 permitted | 403 refused   | 403 refused   | 404 permitted | 401       | 401           |
| `POST /appointments/:id/check-in`   | 403 refused   | 404 permitted | 404 permitted | 403 refused   | 403 refused   | 404 permitted | 401       | 401           |
| `POST /appointments/:id/reschedule` | 400 permitted | 400 permitted | 400 permitted | 403 refused   | 403 refused   | 400 permitted | 401       | 401           |
| `GET /appointments/:id`             | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 401       | 401           |
| `GET /appointments`                 | 200 permitted | 400 permitted | 400 permitted | 400 permitted | 400 permitted | 400 permitted | 401       | 401           |
| `POST /appointments`                | 400 permitted | 400 permitted | 400 permitted | 403 refused   | 403 refused   | 400 permitted | 401       | 401           |
| `GET /doctors`                      | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 401       | 401           |
| `GET /me`                           | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 401       | 401           |
| `GET /patients/:id`                 | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 401       | 401           |
| `GET /patients`                     | 403 refused   | 400 permitted | 400 permitted | 400 permitted | 400 permitted | 400 permitted | 401       | 401           |
| `POST /patients`                    | 403 refused   | 400 permitted | 400 permitted | 403 refused   | 403 refused   | 400 permitted | 401       | 401           |
| `GET /policies/current`             | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 401       | 401           |
| `PATCH /sessions/:id/capacity`      | 403 refused   | 403 refused   | 403 refused   | 403 refused   | 403 refused   | 400 permitted | 401       | 401           |
| `GET /sessions/:id/slots`           | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 401       | 401           |
| `POST /sessions/:id/walk-ins`       | 403 refused   | 400 permitted | 400 permitted | 403 refused   | 403 refused   | 400 permitted | 401       | 401           |
| `GET /sessions/:id`                 | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 404 permitted | 401       | 401           |
| `GET /sessions`                     | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 200 permitted | 401       | 401           |
| `POST /sessions`                    | 403 refused   | 403 refused   | 403 refused   | 403 refused   | 403 refused   | 400 permitted | 401       | 401           |

Besides the matrix, a patient was also refused (403) on the staff routes named in the brief with realistic payloads:
`POST /sessions/{id}/walk-ins`, `POST /appointments/{id}/check-in`, `PATCH /sessions/{id}/capacity`, `POST /sessions`,
`GET /patients?q=...` and `POST /patients`.

## Assignment scope (measured)

`reception3@hqms.test` (doctors 3 and 4) against resources of doctor 1 (a future session and a patient@ appointment) and
`doctor@hqms.test` (doctor 1) against resources of doctor 3. All 13 attempts returned 403 with no side effects:

- reception3: `GET /appointments/{id}`, `POST .../cancel`, `POST .../reschedule`, `POST .../check-in`,
  `POST /sessions/{id}/walk-ins`, `POST /appointments` (book into the session), `GET /sessions/{id}`,
  `GET /sessions/{id}/slots`, `GET /appointments?sessionId=`, and rescheduling an in-scope appointment into an
  out-of-scope session (10 attempts);
- doctor@: `GET /appointments/{id}`, `GET /sessions/{id}`, `GET /appointments?sessionId=` of doctor 3 (3 attempts).

List endpoints filter by scope instead of leaking: `GET /sessions?doctorId={doctor 1}` as reception3 returned an empty
list and `GET /appointments?patientId={patient@}` returned no doctor-1 rows. Positive controls: reception3 reads a
doctor-3 appointment, doctor@ reads a doctor-1 appointment, admin reads both (all 200).

## Limitations

- "Permitted" cells show that the guard admits the role, not that the operation would succeed with a valid payload;
  successful flows are covered by the T1 suite, the API's own integration tests and (later) the E2E flow.
- Only a forged cookie and no cookie are tested for unauthenticated access. Expired sessions, logout revocation and
  login rate limiting are covered in `apps/api/test`, not here.
- `GET /sessions/{id}/queue`, SSE, document, instruction, assistant and follow-up routes do not exist yet and are not
  covered; the route-derived matrix will pick up new controllers automatically, but their cross-patient cases
  (document, instruction and message reads) need explicit tests when they are built.
- Staff patient lookup by id (`GET /patients/:id`) is hospital-wide in this build (D-020); D-022 plans to narrow it for
  doctors and follow-up staff and to restrict search to reception and admin. This suite does not assert either
  behaviour; it will need updating then.
- The side-effect fingerprint excludes audit rows for login and search operations, which the build is allowed to write
  on a refused or read request.
