import { useRef, useState } from 'react';
import { toast } from 'sonner';
import type { DocumentMeta, InstructionVersion } from '@hqms/contracts';
import { useDocuments, useInstructions, useUploadDocument } from '@/api';
import { PatientPage } from '@/components/layout/PatientPage';
import { Field } from '@/components/layout/Field';
import { EmptyState, ErrorState, SkeletonRows } from '@/components/queue';
import { InlineAlert } from '@/components/scheduling/status';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { PATIENT_DOCUMENT_STATUS, UPLOAD_LIMIT_WORDS, fileSizeWord, validateUpload } from '@/lib/followup';
import { formatIST } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';

/** Server upload errors in plain words. The server message is a fallback only. */
export function uploadErrorWords(e: unknown): string {
  if (e instanceof ApiRequestError) {
    switch (e.code) {
      case 'UPLOAD_TOO_LARGE':
        return 'This file is larger than 10 MB. Choose a smaller file or a lower-resolution scan.';
      case 'UPLOAD_TOO_MANY_PAGES':
        return 'This document has more than 10 pages. Upload the pages that matter most, or split it into two files.';
      case 'UNSUPPORTED_MEDIA_TYPE':
        return 'This file type is not accepted. Choose a PDF, PNG or JPEG.';
      case 'NETWORK':
        return e.message;
      default:
        return 'The upload did not go through. Try again. If it keeps failing, tell reception.';
    }
  }
  return 'The upload did not go through. Try again.';
}

function DocumentRow({ doc }: { doc: DocumentMeta }) {
  const s = PATIENT_DOCUMENT_STATUS[doc.status];
  const verified = doc.status === 'verified';
  return (
    <li className={cn('border-l-[3px] px-4 py-3', verified ? 'border-l-done' : 'border-l-rule')} data-status={doc.status}>
      <p className="truncate font-bold">{doc.originalName}</p>
      <p className={cn('font-bold', verified ? 'text-done' : 'text-ink')}>{s.word}</p>
      <p className="text-muted-foreground">{s.hint}</p>
      <p className="text-sm text-muted-foreground tabular-nums">
        Uploaded {formatIST(doc.createdAt, 'date-time')}, {fileSizeWord(doc.sizeBytes)}, {doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}
      </p>
    </li>
  );
}

function VerifiedInstructions({ patientId }: { patientId: string }) {
  const q = useInstructions(patientId);
  const [open, setOpen] = useState(false);
  const current = (q.data ?? []).filter((v: InstructionVersion) => v.status === 'current');
  if (!q.data || current.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mt-6">
      <CollapsibleTrigger className="flex min-h-12 w-full items-center justify-between rounded-md px-1 text-left text-lg font-bold    ">
        <span>
          Instructions your doctor verified <span className="tabular-nums">({current.length})</span>
        </span>
        <ChevronDown aria-hidden="true" className={open ? 'size-5 rotate-180' : 'size-5'} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
          {current.map((v) => (
            <li key={v.id} className="border-l-[3px] border-l-done px-4 py-3">
              <p className="font-bold">{v.title}</p>
              <p className="text-muted-foreground tabular-nums">
                Version {v.version}, verified {formatIST(v.verifiedAt, 'date')} by {v.verifiedByName}
              </p>
              <p className="mt-2 max-w-prose whitespace-pre-wrap">{v.body}</p>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function DocumentsPage() {
  const { me } = useAuth();
  const patientId = me?.patientId ?? null;
  const docs = useDocuments(patientId);
  const upload = useUploadDocument();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (f: File | null) => {
    upload.reset();
    setFile(f);
    setFileError(f ? validateUpload(f) : null);
  };

  const submit = () => {
    if (!patientId) return;
    if (!file) {
      setFileError('Choose a file to upload.');
      inputRef.current?.focus();
      return;
    }
    const problem = validateUpload(file);
    if (problem) {
      setFileError(problem);
      return;
    }
    upload.mutate(
      { file, patientId },
      {
        onSuccess: () => {
          toast.success('Uploaded');
          setFile(null);
          if (inputRef.current) inputRef.current.value = '';
        },
      },
    );
  };

  return (
    <PatientPage title="Documents" description="Upload a prescription or discharge note. Your doctor checks it before it is used.">
      {!patientId ? (
        <EmptyState title="No patient record is linked to this sign-in">Ask reception to link your record so you can upload documents.</EmptyState>
      ) : (
        <>
          <form
            className="grid gap-3 rounded-xl border border-rule bg-surface p-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <Field label="Choose a file" hint={UPLOAD_LIMIT_WORDS} error={fileError}>
              <Input
                ref={inputRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                className="h-12 py-2"
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
            </Field>
            {upload.isError ? <InlineAlert title="Not uploaded">{uploadErrorWords(upload.error)}</InlineAlert> : null}
            <Button type="submit" size="lg" disabled={upload.isPending} className="sm:w-fit">
              {upload.isPending ? 'Uploading…' : 'Upload document'}
            </Button>
          </form>

          <h2 className="mt-6 mb-2 text-lg font-bold">Your documents</h2>
          {docs.isPending ? (
            <SkeletonRows count={3} />
          ) : docs.isError && !docs.data ? (
            <ErrorState title="Your documents could not be loaded" error={docs.error} onRetry={() => void docs.refetch()} />
          ) : docs.data.length === 0 ? (
            <EmptyState title="No documents yet">Upload a photo or PDF of a prescription or discharge note. It appears here with its status.</EmptyState>
          ) : (
            <ul className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
              {[...docs.data]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((d) => (
                  <DocumentRow key={d.id} doc={d} />
                ))}
            </ul>
          )}
          <VerifiedInstructions patientId={patientId} />
        </>
      )}
    </PatientPage>
  );
}
