import { cn } from '@/lib/utils';
import { GroupTag } from './GroupTag';

export type TokenSize = 'sm' | 'md' | 'lg' | 'xl' | 'display';

const SIZE: Record<TokenSize, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-2xl',
  xl: 'text-4xl',
  display: 'text-[clamp(4rem,10vw,8.75rem)] leading-none',
};

interface TokenTextProps {
  /** Group letter + 3-digit sequence, e.g. "A-014". */
  token: string;
  size?: TokenSize;
  /** Priority entries keep their original token and show a P tag beside it. */
  priority?: boolean;
  className?: string;
}

/** Token numerals: bold, tabular, ink. Colour lives on the tag and the row edge, not on the digits. */
export function TokenText({ token, size = 'md', priority = false, className }: TokenTextProps) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        data-token={token}
        className={cn('font-bold tracking-tight whitespace-nowrap tabular-nums', SIZE[size], size === 'display' && 'tracking-tighter')}
      >
        {token}
      </span>
      {priority ? <GroupTag group="P" showName={size !== 'sm' && size !== 'md'} /> : null}
    </span>
  );
}
