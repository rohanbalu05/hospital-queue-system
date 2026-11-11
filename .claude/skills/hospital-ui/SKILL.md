---
name: hospital-ui
description: Binding visual and interaction brief for the HQMS web app: tokens, type, layout per role, queue colour semantics and the never-do list. Load before building or reviewing any screen in apps/web.
---

# HQMS UI brief

**Subject:** the outpatient floor of a busy Bengaluru hospital. **Audience:** reception staff at a crowded desk, doctors between patients, follow-up nurses, patients on their phones, and a TV in the waiting room. **Job:** make the queue legible and trustworthy, so everyone can see who is next and why.

**Direction: hospital wayfinding signage.** Calm, near-monochrome surfaces. Colour is reserved for queue meaning only, the way hospital signs use colour for departments. Big, unmistakable numerals for tokens. Staff screens are dense and fast; patient screens are spacious and reassuring; the waiting-room display is readable from 8 metres.

## Tokens

| Token | Hex | Use |
| --- | --- | --- |
| `ink` | `#16232B` | Text, primary buttons (solid ink, white text) |
| `paper` | `#F6F7F4` | App background |
| `surface` | `#FFFFFF` | Panels, tables, inputs |
| `rule` | `#D9DED9` | 1px borders and dividers |
| `muted` | `#5B6770` | Secondary text |
| `appt` | `#2B5DA8` | Group A: appointment |
| `walkin` | `#9A5B00` | Group W: walk-in |
| `priority` | `#B42318` | P: authorized clinical priority; also destructive actions |
| `aging` | `#6B3FA0` | Aging override reason |
| `done` | `#1E7A4C` | Completed, verified, resolved |

- Queue colours appear as **tags with their letter** (A, W, P) and as a 3px left edge on queue rows. Never colour-only.
- Tag style: tinted background at 10% of the colour, text in the full colour, 4px radius.
- Radius: 6px on controls, 10px on panels. No shadows except on dialogs and popovers. No gradients anywhere.
- Dark mode: not required for this build.

## Type

- One family: **Atkinson Hyperlegible** (`@fontsource/atkinson-hyperlegible`, weights 400 and 700), chosen for legibility for low-vision readers. Use it everywhere; tabular figures (`font-variant-numeric: tabular-nums`) for every time, count and token.
- Scale (px): 12 · 14 · 16 · 20 · 28 · 40, plus a display token size of 120–160.
- Staff screens: 14px body, 40px table rows. Patient screens: 16px body, 48px touch targets. Sentence case everywhere.

## Token format

Display token = group letter + 3-digit sequence within the session: `A-014`, `W-005`. Priority entries keep their original token and show a P tag beside it.

## Screens by role

**Reception desk (1440 px, three columns).**
- Left: find arrivals by name, phone or appointment.
- Centre: the selected doctor's session board, with lanes for waiting A and W, called, and in service; a capacity bar shows booked x/10 and walk-in y/5.
- Right: an action panel with check in, admit walk-in, mark absent and re-enter skipped. Keyboard: `/` focuses search, `Enter` checks in the selected arrival.

**Doctor console (1280 px and tablet).**
- One large **Now** panel: the in-service patient, with Start and Complete.
- A **Call next** button. After each call, show the decision reason in plain words, e.g. "Called by rotation: 2nd appointment of A, A, W" or "Aging: waited 47 min". The reason is the feature: always show it.
- Below: the waiting list in policy order, plus Pause and Resume.
- A review inbox for OCR drafts awaiting verification shows the draft and the editable instruction side by side.

**Waiting-room display (1920×1080 TV, landscape).**
- One column per doctor: room name, a huge **Now calling** token, then the next 3 tokens.
- Show a "Last updated hh:mm:ss" line. If disconnected for more than 5 s, show "Reconnecting…".
- **Never names or any patient detail.** Tokens only.

**Patient (390 px first).**
- Book: doctor, date, session, confirm.
- My visit: token, position, and the ETA as a range ("about 25–40 min"). When paused or unsupported, show "Estimate paused" instead.
- Documents and follow-ups.
- "Questions about your instructions": answers cite the verified instruction version. Unsupported questions show "Sent to the follow-up team. You'll hear back by <due time>."

**Follow-up staff (1440 px).** An owned-task inbox with columns for due, overdue, patient, source visit and status. Task detail has a disposition form and a "Book return visit" action that goes through normal capacity.

**Admin (1440 px).** Sessions and capacity configuration, staff assignments, a read-only view of the current policy version, and reports (throughput, median and p95 waits by group) with "measured" vs "target" labelled.

## Interaction

- Every async view has loading (skeleton rows, not spinners on full pages), empty (what to do next), error (what happened and how to fix it), and stale/reconnecting states.
- Booking and call-next must work by keyboard alone, with a visible 2px `ink` focus ring.
- Motion: one moment only. The display highlights a newly called token for 300 ms. Respect `prefers-reduced-motion`.
- Buttons name the action ("Check in", "Call next", "Verify instruction"); toasts reuse the same verb ("Checked in").

## Never do

- No landing or marketing page. The app opens on login, then the role's home.
- No KPI hero cards, fake stats or decorative charts.
- No grids of identical rounded cards. Use tables and lanes for queues.
- No gradients, glassmorphism, all-caps eyebrow labels, emoji, or "AI sparkle" icons on the assistant.
- No icon-only primary actions.
- No colour-only status: always the letter or word too.
- No patient names, phone numbers or clinical text on the public display or in logs.
- No lorem ipsum. Use realistic Bengaluru names, departments (General Medicine, Paediatrics, ENT, Orthopaedics, Dermatology) and IST times.

## Done means

Playwright screenshots at 1440 px and 390 px (and 1920×1080 for the display) are saved to `docs/evidence/screenshots/` and looked at. Nothing breaks this brief, and the keyboard paths work.
