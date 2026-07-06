// Robustness metrics + bootstrap confidence interval. Deterministic (seeded PRNG),
// no LLM-judge. robustness_delta = clean_accuracy - attacked_accuracy (accuracy drop).

/** mulberry32: small seeded PRNG so bootstrap CIs are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export interface DeltaCI {
  delta: number; // clean_acc - attack_acc (point estimate)
  lo: number;    // 2.5th percentile
  hi: number;    // 97.5th percentile
}

/**
 * Paired bootstrap over cases. `clean` / `attack` are aligned per-case correctness (1/0).
 * Resamples case indices with replacement B times and takes the 95% percentile interval of the delta.
 */
export function bootstrapDeltaCI(clean: number[], attack: number[], seed = 42, B = 2000): DeltaCI {
  const n = clean.length;
  const point = mean(clean) - mean(attack);
  if (n === 0) return { delta: 0, lo: 0, hi: 0 };
  const rand = rng(seed);
  const deltas: number[] = [];
  for (let b = 0; b < B; b++) {
    let cSum = 0, aSum = 0;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rand() * n);
      cSum += clean[idx]; aSum += attack[idx];
    }
    deltas.push((cSum - aSum) / n);
  }
  deltas.sort((x, y) => x - y);
  const pct = (p: number) => deltas[Math.min(B - 1, Math.max(0, Math.floor(p * B)))];
  return { delta: point, lo: pct(0.025), hi: pct(0.975) };
}

export { mean, rng };
