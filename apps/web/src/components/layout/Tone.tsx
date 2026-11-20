import { cn } from '@/lib/utils';

export type Tone = 'info' | 'warning' | 'urgent';

/**
 * Severity for banners and notices. It is carried by a word and an edge weight, never by colour alone, and none of it is
 * red: red belongs to authorized clinical priority and destructive actions (hospital-ui brief).
 */
export const TONE_EDGE: Record<Tone, string> = {
  info: 'border-l-[3px] border-l-rule',
  warning: 'border-l-[3px] border-l-ink',
  urgent: 'border-l-[6px] border-l-ink',
};

export const TONE_WORD: Record<Tone, string | null> = {
  info: null,
  warning: 'Heads up',
  urgent: 'Action needed',
};

/** The word that names the severity: solid ink for urgent, outlined for a warning, nothing for plain information. */
export function ToneTag({ tone, className }: { tone: Tone; className?: string }) {
  const word = TONE_WORD[tone];
  if (!word) return null;
  return (
    <span
      className={cn(
        'inline-block rounded-xs px-1.5 py-0.5 text-sm leading-5 font-bold',
        tone === 'urgent' ? 'bg-ink text-white' : 'border border-ink text-ink',
        className,
      )}
    >
      {word}
    </span>
  );
}
