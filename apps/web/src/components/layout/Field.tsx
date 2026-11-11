import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

interface FieldProps {
  label: string;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Inline error under the control; also marks the control invalid. */
  error?: string | null;
  /** One control (cloned with id and aria props) or a function that places them, e.g. on a Select trigger. */
  children: ReactElement<Partial<FieldControlProps>> | ((props: FieldControlProps) => ReactNode);
  className?: string;
}

/** Label, one control, hint and inline error wired together for assistive tech. */
export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  const props: FieldControlProps = {
    id,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(error ? { 'aria-invalid': true } : {}),
  };
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {typeof children === 'function' ? children(props) : cloneElement(children, props)}
      {hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-sm font-bold">
          {error}
        </p>
      ) : null}
    </div>
  );
}
