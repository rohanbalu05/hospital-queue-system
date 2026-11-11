/** Small, dependency-free statistics helpers. Inputs are plain number arrays. */

/** Rounds to three decimals so serialised results are stable and readable. */
export function r3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function sampleSd(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (values.length - 1));
}

/** Quantile of an ascending-sorted array, linear interpolation between ranks (type 7). */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function quantile(values: readonly number[], q: number): number {
  return quantileSorted(
    [...values].sort((a, b) => a - b),
    q,
  );
}

export interface Summary {
  n: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
}

export function summarize(values: readonly number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    mean: r3(mean(sorted)),
    median: r3(quantileSorted(sorted, 0.5)),
    p95: r3(quantileSorted(sorted, 0.95)),
    max: r3(sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number)),
  };
}

export interface PairedDiff {
  trials: number;
  /** Mean of (policy - baseline) over trials. */
  meanDiff: number;
  /** Normal-approximation 95% interval for the mean paired difference. */
  ci95Low: number;
  ci95High: number;
  policyHigher: number;
  policyLower: number;
  equal: number;
}

export function pairedDiff(policy: readonly number[], baseline: readonly number[]): PairedDiff {
  const n = Math.min(policy.length, baseline.length);
  const diffs: number[] = [];
  let higher = 0;
  let lower = 0;
  let equal = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (policy[i] as number) - (baseline[i] as number);
    diffs.push(d);
    if (Math.abs(d) < 1e-9) equal += 1;
    else if (d > 0) higher += 1;
    else lower += 1;
  }
  const m = mean(diffs);
  const half = n > 1 ? (1.96 * sampleSd(diffs)) / Math.sqrt(n) : 0;
  return {
    trials: n,
    meanDiff: r3(m),
    ci95Low: r3(m - half),
    ci95High: r3(m + half),
    policyHigher: higher,
    policyLower: lower,
    equal,
  };
}
