import type { DecisionReason } from '@hqms/contracts';

/** A and W are queue groups; P is authorized clinical priority (shown beside the original token). */
export type TagGroup = 'A' | 'W' | 'P';

export interface GroupMeta {
  letter: TagGroup;
  /** Plain word, shown next to the letter where there is room. */
  name: string;
  /** Tinted background at 10% of the colour, text in full colour. */
  tag: string;
  /** 3px left edge on queue rows. */
  edge: string;
}

export const GROUPS: Record<TagGroup, GroupMeta> = {
  A: { letter: 'A', name: 'Appointment', tag: 'bg-appt/10 text-appt', edge: 'border-l-appt' },
  W: { letter: 'W', name: 'Walk-in', tag: 'bg-walkin/10 text-walkin', edge: 'border-l-walkin' },
  P: { letter: 'P', name: 'Priority', tag: 'bg-priority/10 text-priority', edge: 'border-l-priority' },
};

export interface ReasonMeta {
  /** Short word shown in the reason colour. */
  word: string;
  text: string;
  edge: string;
}

/** Reason colours: rotation = ink, aging = aging, clinical priority = priority. */
export const REASONS: Record<DecisionReason, ReasonMeta> = {
  ROTATION: { word: 'Rotation', text: 'text-ink', edge: 'border-l-ink' },
  AGING: { word: 'Aging', text: 'text-aging', edge: 'border-l-aging' },
  CLINICAL_PRIORITY: { word: 'Clinical priority', text: 'text-priority', edge: 'border-l-priority' },
  NO_ALLOCATION: { word: 'No one waiting', text: 'text-muted-foreground', edge: 'border-l-rule' },
};
