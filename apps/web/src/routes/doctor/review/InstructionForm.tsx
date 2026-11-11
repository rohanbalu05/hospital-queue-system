import { useState } from 'react';
import { VerifyInstructionRequest, type InstructionVersion } from '@hqms/contracts';
import { Field } from '@/components/layout/Field';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

interface InstructionFormProps {
  initialTitle: string;
  initialBody: string;
  /** Current instruction versions for this patient: a new version can supersede one of them. */
  current: InstructionVersion[];
  sourceDraftId?: string | undefined;
  pending: boolean;
  error: string | null;
  onVerify: (req: VerifyInstructionRequest) => void;
}

/** First short line of an OCR draft is a reasonable title to start from; the doctor edits it. */
export function titleFromDraft(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return first.length >= 3 && first.length <= 80 ? first : '';
}

/** The editable instruction: title and body, prefilled from the draft. Nothing is visible to the assistant until verified. */
export function InstructionForm({ initialTitle, initialBody, current, sourceDraftId, pending, error, onVerify }: InstructionFormProps) {
  const [title, setTitle] = useState(initialTitle);
  const [body, setBody] = useState(initialBody);
  const [target, setTarget] = useState('new');
  const [errors, setErrors] = useState<{ title?: string; body?: string }>({});

  const submit = () => {
    const req = {
      title: title.trim(),
      body: body.trim(),
      ...(target !== 'new' ? { instructionId: target } : {}),
      ...(sourceDraftId ? { sourceDraftId } : {}),
    };
    const parsed = VerifyInstructionRequest.safeParse(req);
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const i of parsed.error.issues) {
        if (i.path[0] === 'title') next.title = 'Give the instruction a title of at least 3 characters.';
        if (i.path[0] === 'body') next.body = 'Write the instruction, at least 3 characters.';
      }
      setErrors(next);
      return;
    }
    setErrors({});
    onVerify(parsed.data);
  };

  return (
    <form
      className="grid gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {current.length > 0 ? (
        <Field label="Save as">
          {(p) => (
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger {...p} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="new">New instruction</SelectItem>
                {current.map((c) => (
                  <SelectItem key={c.instructionId} value={c.instructionId}>
                    New version of &ldquo;{c.title}&rdquo; (now version {c.version})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      ) : null}
      <Field label="Title" error={errors.title ?? null}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} autoComplete="off" />
      </Field>
      <Field label="Instruction" error={errors.body ?? null} hint="Check this against the original document. The patient assistant may quote it once verified.">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} maxLength={5000} className="min-h-64" />
      </Field>
      {error ? <InlineAlert title="The instruction was not verified">{error}</InlineAlert> : null}
      <div>
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify instruction'}
        </Button>
      </div>
    </form>
  );
}
