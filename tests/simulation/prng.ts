/**
 * Seeded pseudo-random numbers for the queue simulation. Math.random is never used: every draw comes
 * from mulberry32, so a (scenario, seed) pair always generates the same session.
 */

/** mulberry32: small, fast 32-bit generator with a full 2^32 period. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly nextFloat: () => number;

  constructor(seed: number) {
    this.nextFloat = mulberry32(seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextFloat();
  }

  bernoulli(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box-Muller; always consumes two uniforms so the stream position is stable. */
  normal(): number {
    const u1 = 1 - this.next(); // in (0, 1]
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Exponential with the given mean. */
  exp(mean: number): number {
    return -mean * Math.log(1 - this.next());
  }

  /** Lognormal parameterised by its arithmetic mean and the sigma of the underlying normal. */
  lognormalByMean(mean: number, sigma: number): number {
    const mu = Math.log(mean) - (sigma * sigma) / 2;
    return Math.exp(mu + sigma * this.normal());
  }

  /** Index drawn with the given (not necessarily normalised) weights. */
  weighted(weights: readonly number[]): number {
    const total = weights.reduce((s, w) => s + w, 0);
    let x = this.next() * total;
    for (let i = 0; i < weights.length; i += 1) {
      x -= weights[i] as number;
      if (x < 0) return i;
    }
    return weights.length - 1;
  }

  /** Fisher-Yates shuffle of a copy. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}
