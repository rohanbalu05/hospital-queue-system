// Run: node --test scripts/demo-session-now.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './demo-session-now.mjs';

// IST = UTC+5:30. at('08:45') is 2026-11-20 08:45 IST.
const at = (hhmm, day = '2026-11-20') => new Date(`${day}T${hhmm}:00+05:30`);
const seeded = [
  { id: 'm', status: 'scheduled', label: 'morning', startsAt: at('09:00').toISOString(), endsAt: at('13:00').toISOString() },
  { id: 'a', status: 'scheduled', label: 'afternoon', startsAt: at('14:00').toISOString(), endsAt: at('18:00').toISOString() },
];

test('08:45 opens the seeded morning session early', () => {
  const a = decide(at('08:45'), seeded);
  assert.equal(a.type, 'open-early');
  assert.equal(a.session.id, 'm');
});

test('10:00 opens the seeded morning session', () => {
  const a = decide(at('10:00'), seeded);
  assert.deepEqual([a.type, a.session.id, a.open], ['use', 'm', true]);
});

test('10:00 with an open session does nothing; a paused one is only reported', () => {
  assert.equal(decide(at('10:00'), [{ ...seeded[0], status: 'open' }, seeded[1]]).open, false);
  const p = decide(at('10:00'), [{ ...seeded[0], status: 'paused' }, seeded[1]]);
  assert.deepEqual([p.type, p.open], ['use', false]);
});

test('12:45 creates an afternoon session 12:40-14:00 (ends where the next one starts)', () => {
  const a = decide(at('12:45'), seeded);
  assert.equal(a.type, 'create');
  assert.equal(a.label, 'afternoon');
  assert.equal(a.startsAt, at('12:40').toISOString());
  assert.equal(a.endsAt, at('14:00').toISOString());
  assert.equal(a.sessionDate, '2026-11-20');
});

test('17:45 creates an evening session 17:40-20:40', () => {
  const a = decide(at('17:45'), seeded);
  assert.equal(a.type, 'create');
  assert.equal(a.label, 'evening');
  assert.equal(a.startsAt, at('17:40').toISOString());
  assert.equal(a.endsAt, at('20:40').toISOString());
});

test('23:30 creates a night session crossing midnight, dated by its IST start', () => {
  const a = decide(at('23:30'), seeded);
  assert.equal(a.type, 'create');
  assert.equal(a.label, 'night');
  assert.equal(a.sessionDate, '2026-11-20');
  assert.equal(a.startsAt, at('23:25').toISOString());
  assert.equal(a.endsAt, at('02:25', '2026-11-21').toISOString());
});

test('02:00 creates a night session dated today when the 23:25 one has under 45 min left', () => {
  const late = [
    { id: 'n', status: 'open', label: 'night', startsAt: at('23:25', '2026-11-19').toISOString(), endsAt: at('02:25').toISOString() },
  ];
  const a = decide(at('02:00'), [...late, ...seeded]);
  assert.equal(a.type, 'create');
  assert.equal(a.label, 'night');
  assert.equal(a.sessionDate, '2026-11-20');
  assert.equal(a.startsAt, at('01:55').toISOString());
});

test('02:00 with no earlier session creates a night session', () => {
  const a = decide(at('02:00'), seeded);
  assert.deepEqual([a.type, a.label, a.sessionDate], ['create', 'night', '2026-11-20']);
});

test('idempotent: after creating, the next run finds it covering and open', () => {
  const a = decide(at('23:30'), seeded);
  const created = { id: 'x', status: 'open', label: a.label, startsAt: a.startsAt, endsAt: a.endsAt };
  const again = decide(at('23:31'), [...seeded, created]);
  assert.deepEqual([again.type, again.open], ['use', false]);
});

test('too little room before the next session: opens the next one instead', () => {
  const next = { id: 'n', status: 'scheduled', label: 'afternoon', startsAt: at('13:50').toISOString(), endsAt: at('18:00').toISOString() };
  assert.equal(decide(at('13:05'), [next]).type, 'open-next');
});
