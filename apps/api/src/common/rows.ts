/** The single row a statement is guaranteed to return (INSERT ... RETURNING, UPDATE ... RETURNING). */
export function one<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`Expected a row from ${what}`);
  return row;
}
