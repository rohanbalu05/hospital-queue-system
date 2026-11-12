import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequest } from '@hqms/contracts';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiRequestError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ROLE_HOME, useAuth } from '@/lib/auth';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, HOSPITAL_NAME, HOSPITAL_PLACE, SHOW_DEMO } from '@/lib/config';

function loginErrorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.status === 401 || e.code === 'UNAUTHENTICATED')
      return 'The email or password is not right. Check both and try again.';
    if (e.code === 'RATE_LIMITED') return 'Too many attempts. Wait a minute, then try again.';
    return e.message;
  }
  return 'Sign in failed. Try again.';
}

export default function LoginPage() {
  const { login, loginPending } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LoginRequest>({
    resolver: zodResolver(LoginRequest),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginRequest) {
    setFormError(null);
    try {
      const me = await login(values);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith(ROLE_HOME[me.role]) ? from : ROLE_HOME[me.role], { replace: true });
    } catch (e) {
      setFormError(loginErrorMessage(e));
      form.setFocus('password');
    }
  }

  function fillDemo(email: string) {
    form.setValue('email', email, { shouldValidate: false });
    form.setValue('password', DEMO_PASSWORD, { shouldValidate: false });
    form.setFocus('password');
  }

  return (
    <div className="min-h-dvh bg-paper">
      <header className="h-14 bg-ink text-white">
        <div className="mx-auto flex h-full max-w-5xl items-center gap-3 px-4">
          <span className="text-lg font-bold">{HOSPITAL_NAME}</span>
          <span className="hidden text-sm text-white/80 sm:inline">{HOSPITAL_PLACE}</span>
        </div>
      </header>

      <main
        className={cn(
          'mx-auto grid max-w-5xl gap-8 px-4 py-8 md:gap-12 md:py-12',
          SHOW_DEMO && 'md:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]',
        )}
      >
        <section aria-labelledby="signin-title">
          <h1 id="signin-title" className="text-2xl font-bold">
            Sign in
          </h1>
          <p className="mt-1 text-muted-foreground">Outpatient appointments and queue.</p>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="mt-6 space-y-4" aria-busy={loginPending}>
              {formError ? (
                <div
                  role="alert"
                  className="rounded-md border border-l-[3px] border-rule border-l-ink bg-surface px-3 py-2"
                >
                  <p className="font-bold">Could not sign in</p>
                  <p>{formError}</p>
                </div>
              ) : null}
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        autoComplete="username"
                        inputMode="email"
                        autoFocus
                        className="h-12 text-base"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" className="h-12 text-base" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" size="lg" className="w-full" disabled={loginPending}>
                {loginPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </form>
          </Form>
        </section>

        {SHOW_DEMO ? (
          <section aria-labelledby="demo-title" className="min-w-0">
            <h2 id="demo-title" className="text-lg font-bold">
              Demo accounts
            </h2>
            <p className="mt-1 text-muted-foreground">
              This is a college demo build. Every account uses the password{' '}
              <span className="font-bold tabular-nums">{DEMO_PASSWORD}</span>.
            </p>
            <div className="mt-4 overflow-hidden rounded-xl border border-rule bg-surface">
              <Table>
                <TableHeader>
                  <TableRow className="h-10">
                    <TableHead className="px-3">Role</TableHead>
                    <TableHead className="px-3">Email</TableHead>
                    <TableHead className="hidden px-3 sm:table-cell">Opens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {DEMO_ACCOUNTS.map((a) => (
                    <TableRow key={a.email} className="h-10">
                      <TableCell className="px-3 font-bold">{a.role}</TableCell>
                      <TableCell className="px-3">
                        <Button
                          type="button"
                          variant="link"
                          className="h-auto p-0 text-sm underline"
                          onClick={() => fillDemo(a.email)}
                          aria-label={`Fill in ${a.role} demo account, ${a.email}`}
                        >
                          {a.email}
                        </Button>
                      </TableCell>
                      <TableCell className="hidden px-3 text-muted-foreground sm:table-cell">{a.opens}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
