import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { QueueEntry } from '@hqms/contracts';
import { StaffShell } from '@/components/layout/Shells';
import { SessionBoardLive } from './SessionBoardLive';
import { SESSION_ID } from './fixtures';

/** Dev route /_dev/board?session=<id>: the live session board on its own, for screenshots and reception reuse. */
export default function BoardDevPage() {
  const [params] = useSearchParams();
  const sessionId = params.get('session') ?? SESSION_ID;
  const [selected, setSelected] = useState<QueueEntry | null>(null);
  return (
    <StaffShell
      title="Session board"
      description={selected ? `Selected ${selected.token}, ${selected.patientName}` : 'Dev view of the live board. Select a row to see selection.'}
    >
      <div className="max-w-[640px]">
        <SessionBoardLive sessionId={sessionId} selectedEntryId={selected?.id ?? null} onSelectEntry={setSelected} />
      </div>
    </StaffShell>
  );
}
