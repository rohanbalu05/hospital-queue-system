import { HOSPITAL_NAME } from '@/lib/config';

/**
 * Public waiting-room display (1920x1080). No auth, tokens only, never names or patient detail.
 * W0 placeholder; W2 adds one column per doctor with the Now calling token and the next three.
 */
export default function DisplayPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="flex h-24 items-center bg-ink px-12 text-white">
        <h1 className="text-4xl font-bold">{HOSPITAL_NAME}</h1>
        <p className="ml-auto text-2xl">Outpatient queue</p>
      </header>
      <main className="flex flex-1 items-center px-12">
        <div>
          <p className="text-4xl font-bold">No sessions are running</p>
          <p className="mt-3 max-w-3xl text-2xl text-muted-foreground">
            Each doctor&apos;s room, the token now being called and the next three tokens appear here when a session starts.
          </p>
        </div>
      </main>
    </div>
  );
}
