export interface MarkovResult {
  tpm: number[][];
  stateLabels: string[];
  steadyState: number[];
  simulationYears: number;
}

export interface DeteriorationPoint {
  year: number;
  avgCondition: number;
  p5: number;
  p95: number;
  worstCase: number;
  bestCase: number;
}

export interface ConditionState {
  label: string;
  min: number;
  max: number;
  midpoint: number;
}

export type ConditionScaleId = "scale_0_100" | "nbi_0_9" | "pci_0_100" | "scale_0_10";

export const CONDITION_SCALES: Record<ConditionScaleId, ConditionState[]> = {
  scale_0_100: [
    { label: "Excellent", min: 81, max: 100, midpoint: 90 },
    { label: "Good",      min: 61, max: 80,  midpoint: 70 },
    { label: "Fair",      min: 41, max: 60,  midpoint: 50 },
    { label: "Poor",      min: 21, max: 40,  midpoint: 30 },
    { label: "Critical",  min: 0,  max: 20,  midpoint: 10 },
  ],
  nbi_0_9: [
    { label: "Good",  min: 7, max: 9, midpoint: 8 },
    { label: "Fair",  min: 5, max: 6, midpoint: 5.5 },
    { label: "Poor",  min: 0, max: 4, midpoint: 2 },
  ],
  pci_0_100: [
    { label: "Very Good", min: 85, max: 100, midpoint: 92 },
    { label: "Good",      min: 70, max: 84,  midpoint: 77 },
    { label: "Fair",      min: 55, max: 69,  midpoint: 62 },
    { label: "Poor",      min: 40, max: 54,  midpoint: 47 },
    { label: "Very Poor", min: 0,  max: 39,  midpoint: 20 },
  ],
  scale_0_10: [
    { label: "Excellent", min: 9,  max: 10, midpoint: 9.5 },
    { label: "Good",      min: 7,  max: 8,  midpoint: 7.5 },
    { label: "Fair",      min: 5,  max: 6,  midpoint: 5.5 },
    { label: "Poor",      min: 3,  max: 4,  midpoint: 3.5 },
    { label: "Critical",  min: 0,  max: 2,  midpoint: 1   },
  ],
};

const DEFAULT_SCALE: ConditionScaleId = "scale_0_100";

function getStates(scale?: ConditionScaleId): ConditionState[] {
  return CONDITION_SCALES[scale ?? DEFAULT_SCALE];
}

export function getStateIndex(condition: number, scale?: ConditionScaleId): number {
  const states = getStates(scale);
  const maxVal = Math.max(...states.map((s) => s.max));
  const norm = Math.max(0, Math.min(maxVal, condition));
  for (let i = 0; i < states.length; i++) {
    if (norm >= states[i].min) return i;
  }
  return states.length - 1;
}

export function getStateLabels(scale?: ConditionScaleId): string[] {
  return getStates(scale).map((s) => s.label);
}

export function getStateMidpoints(scale?: ConditionScaleId): number[] {
  return getStates(scale).map((s) => s.midpoint);
}

function sampleState(distribution: number[]): number {
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < distribution.length; i++) {
    cumulative += distribution[i];
    if (r < cumulative) return i;
  }
  return distribution.length - 1;
}

/**
 * Calibrate a Markov Transition Probability Matrix from historical condition data.
 * Requires rows with assetId, conditionValue, and optionally a year/time column.
 * Uses Maximum Likelihood Estimation on observed state-to-state transitions.
 */
export function calibrateTPM(
  rows: Array<Record<string, unknown>>,
  conditionColumn: string,
  assetIdColumn?: string,
  yearColumn?: string,
  nStates: number = 5
): number[][] {
  const counts: number[][] = Array.from({ length: nStates }, () =>
    Array(nStates).fill(0)
  );

  if (assetIdColumn && yearColumn) {
    // Group rows by asset, sort by year, count transitions
    const assetMap = new Map<string | number, Array<{ year: number; state: number }>>();

    for (const row of rows) {
      const id = row[assetIdColumn] as string | number;
      const cond = Number(row[conditionColumn]);
      const yr = Number(row[yearColumn]);
      if (isNaN(cond) || isNaN(yr) || id == null) continue;
      const state = getStateIndex(cond);
      if (!assetMap.has(id)) assetMap.set(id, []);
      assetMap.get(id)!.push({ year: yr, state });
    }

    for (const observations of assetMap.values()) {
      observations.sort((a, b) => a.year - b.year);
      for (let i = 0; i + 1 < observations.length; i++) {
        const from = observations[i].state;
        const to = observations[i + 1].state;
        counts[from][to]++;
      }
    }
  } else {
    // No temporal info: use a default physics-based TPM
    return buildDefaultTPM(nStates);
  }

  // Normalize rows; use default row if no transitions observed
  const tpm: number[][] = counts.map((row, i) => {
    const total = row.reduce((a, b) => a + b, 0);
    if (total === 0) return buildDefaultTPM(nStates)[i];
    return row.map((c) => c / total);
  });

  return tpm;
}

/**
 * Build a default physics-based TPM when no historical data is available.
 * Encodes the assumption that assets can only stay or deteriorate one state per period.
 * Rate of deterioration is proportional to current state index (worse assets deteriorate faster).
 */
export function buildDefaultTPM(nStates: number = 5): number[][] {
  const tpm: number[][] = [];
  for (let i = 0; i < nStates; i++) {
    const row = Array(nStates).fill(0);
    if (i === nStates - 1) {
      row[nStates - 1] = 1.0;
    } else {
      const deterRate = 0.05 + i * 0.04; // 5% → 21% per year depending on state
      row[i] = 1 - deterRate;
      row[i + 1] = deterRate;
    }
    tpm.push(row);
  }
  return tpm;
}

/**
 * Run Monte Carlo Markov chain simulation.
 * Returns year-by-year condition statistics.
 */
export function simulateMarkov(
  tpm: number[][],
  initialDistribution: number[],
  years: number = 20,
  nSimulations: number = 1000,
  scale?: ConditionScaleId
): DeteriorationPoint[] {
  const midpoints = getStateMidpoints(scale);
  const yearConditions: number[][] = Array.from({ length: years }, () => []);

  for (let sim = 0; sim < nSimulations; sim++) {
    let state = sampleState(initialDistribution);
    for (let y = 0; y < years; y++) {
      yearConditions[y].push(midpoints[state]);
      state = sampleState(tpm[state]);
    }
  }

  const baseYear = new Date().getFullYear();
  return yearConditions.map((conditions, idx) => {
    const sorted = [...conditions].sort((a, b) => a - b);
    const n = sorted.length;
    const avg = sorted.reduce((a, b) => a + b, 0) / n;
    return {
      year: baseYear + idx + 1,
      avgCondition: Math.round(avg * 10) / 10,
      p5: sorted[Math.floor(n * 0.05)],
      p95: sorted[Math.floor(n * 0.95)],
      worstCase: sorted[0],
      bestCase: sorted[n - 1],
    };
  });
}

/**
 * Compute the steady-state distribution using power iteration.
 */
export function computeSteadyState(tpm: number[][]): number[] {
  const n = tpm.length;
  let pi = Array(n).fill(1 / n);
  for (let iter = 0; iter < 2000; iter++) {
    const next = Array(n).fill(0);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        next[j] += pi[i] * tpm[i][j];
      }
    }
    pi = next;
  }
  return pi.map((v) => Math.round(v * 1000) / 1000);
}

export interface RULResult {
  expectedYears: number;
  pFailureInHorizon: number;
}

/**
 * Compute expected Remaining Useful Life and probability of failure within a horizon.
 * Returns { expectedYears, pFailureInHorizon } where pFailureInHorizon is the
 * fraction of Monte Carlo trajectories that reach the failure state within `horizon` years.
 */
export function computeRUL(
  tpm: number[][],
  currentStateIndex: number,
  failureStateIndex?: number,
  horizon: number = 5
): RULResult {
  const n = tpm.length;
  const failure = failureStateIndex ?? n - 1;
  const nSim = 500;
  let totalYears = 0;
  let failuresWithinHorizon = 0;

  for (let s = 0; s < nSim; s++) {
    let state = currentStateIndex;
    let reachedFailure = false;
    let yearsToFailure = 100;

    for (let y = 0; y < 100; y++) {
      if (state >= failure) {
        yearsToFailure = y;
        reachedFailure = true;
        break;
      }
      state = sampleState(tpm[state]);
    }

    totalYears += reachedFailure ? yearsToFailure : 100;
    if (reachedFailure && yearsToFailure <= horizon) {
      failuresWithinHorizon++;
    }
  }

  return {
    expectedYears: Math.round(totalYears / nSim),
    pFailureInHorizon: Math.round((failuresWithinHorizon / nSim) * 1000) / 1000,
  };
}

/**
 * Apply a treatment to an asset by shifting its condition state upward (toward Excellent).
 * Returns the new TPM-compatible state index after treatment.
 *
 * @param currentStateIndex  Current condition state (0=Excellent … n-1=Critical)
 * @param treatmentType      "preventive" | "minor_rehab" | "major_rehab" | "replacement"
 * @param nStates            Number of discrete states in the model (default 5)
 */
export function applyTreatment(
  currentStateIndex: number,
  treatmentType: "do_nothing" | "preventive" | "minor_rehab" | "major_rehab" | "replacement",
  nStates: number = 5
): number {
  const stateShifts: Record<typeof treatmentType, number> = {
    do_nothing: 0,
    preventive: 1,   // moves up one state (e.g., Fair → Good)
    minor_rehab: 2,  // moves up two states (e.g., Poor → Good)
    major_rehab: 3,  // moves up three states (e.g., Critical → Good)
    replacement: nStates - 1, // resets to Excellent regardless of current state
  };
  const shift = stateShifts[treatmentType] ?? 0;
  return Math.max(0, currentStateIndex - shift);
}

/**
 * Simulate the effect of a treatment intervention on the deterioration forecast.
 * Applies treatment to assets in states ≥ treatmentThresholdState, then re-simulates.
 */
export function simulateWithTreatment(
  tpm: number[][],
  initialDistribution: number[],
  treatmentType: "do_nothing" | "preventive" | "minor_rehab" | "major_rehab" | "replacement",
  treatmentThresholdState: number,
  years: number = 20,
  nSimulations: number = 1000,
  scale?: ConditionScaleId
): DeteriorationPoint[] {
  const nStates = tpm.length;
  const midpoints = getStateMidpoints(scale);
  const yearConditions: number[][] = Array.from({ length: years }, () => []);

  for (let sim = 0; sim < nSimulations; sim++) {
    let state = sampleState(initialDistribution);
    for (let y = 0; y < years; y++) {
      // Apply treatment if state is at or below threshold
      if (state >= treatmentThresholdState) {
        state = applyTreatment(state, treatmentType, nStates);
      }
      yearConditions[y].push(midpoints[state]);
      state = sampleState(tpm[state]);
    }
  }

  const baseYear = new Date().getFullYear();
  return yearConditions.map((conditions, idx) => {
    const sorted = [...conditions].sort((a, b) => a - b);
    const n = sorted.length;
    const avg = sorted.reduce((a, b) => a + b, 0) / n;
    return {
      year: baseYear + idx + 1,
      avgCondition: Math.round(avg * 10) / 10,
      p5: sorted[Math.floor(n * 0.05)],
      p95: sorted[Math.floor(n * 0.95)],
      worstCase: sorted[0],
      bestCase: sorted[n - 1],
    };
  });
}

/**
 * Build the initial state distribution from an array of current conditions.
 */
export function buildInitialDistribution(conditions: number[], nStates: number = 5): number[] {
  const counts = Array(nStates).fill(0);
  for (const c of conditions) {
    counts[getStateIndex(c)]++;
  }
  const total = conditions.length || 1;
  return counts.map((c) => c / total);
}
