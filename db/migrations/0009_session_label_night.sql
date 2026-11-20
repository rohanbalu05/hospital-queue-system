-- 0009: a session can be labelled by the time of day it actually runs (B5, D-037). The demo helper opens a session
-- "now" at any hour; without a night label a 23:00 or 02:00 session had to be called "evening".
-- Label by IST start time: 05:00-11:59 morning, 12:00-16:59 afternoon, 17:00-20:59 evening, 21:00-04:59 night.
ALTER TABLE sessions DROP CONSTRAINT sessions_label_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_label_check CHECK (label IN ('morning', 'afternoon', 'evening', 'night'));
