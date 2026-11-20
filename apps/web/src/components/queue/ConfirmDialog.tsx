import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What will happen, as a question or a command: "Mark A-003 absent", "Skip A-014?". */
  title: string;
  description?: ReactNode;
  /** The action's own verb, reused by the toast: "Mark absent", "Skip". */
  confirmLabel: string;
  /** The way out, in words that say what is kept: "Keep waiting", "Keep called". */
  cancelLabel: string;
  /** Show an optional reason box with this label. The reason is trimmed; empty means none. */
  reasonLabel?: string;
  pending?: boolean;
  destructive?: boolean;
  onConfirm: (reason: string) => void;
}

/**
 * A short confirmation for an action that is hard to notice once done (mark absent, skip). Enter confirms, Escape keeps
 * things as they were, and focus starts on the safe button so a stray Enter cannot act.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  reasonLabel,
  pending = false,
  destructive = false,
  onConfirm,
}: ConfirmDialogProps) {
  const reasonId = useId();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!pending) onConfirm(reason.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          {reasonLabel ? (
            <div className="grid gap-1.5">
              <Label htmlFor={reasonId}>{reasonLabel}</Label>
              <Input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoComplete="off" />
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" autoFocus={!reasonLabel} disabled={pending} onClick={() => onOpenChange(false)}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={pending}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
