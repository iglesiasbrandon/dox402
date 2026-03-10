import { describe, it, expect } from 'vitest';
import { ALLOWED_MODELS, NEURON_RATES, AI_MODEL, RATE_LIMIT_PER_MINUTE, MAX_TOKENS_LIMIT } from '../src/constants';

describe('constants consistency', () => {
  it('every ALLOWED_MODELS key has a NEURON_RATES entry', () => {
    for (const modelId of Object.keys(ALLOWED_MODELS)) {
      expect(NEURON_RATES[modelId], `Missing NEURON_RATES for ${modelId}`).toBeDefined();
    }
  });

  it('every NEURON_RATES entry has positive in and out values', () => {
    for (const [modelId, rates] of Object.entries(NEURON_RATES)) {
      expect(rates.in, `${modelId} .in should be positive`).toBeGreaterThan(0);
      expect(rates.out, `${modelId} .out should be positive`).toBeGreaterThan(0);
    }
  });

  it('AI_MODEL is in ALLOWED_MODELS', () => {
    expect(ALLOWED_MODELS[AI_MODEL]).toBeDefined();
  });

  it('AI_MODEL has NEURON_RATES', () => {
    expect(NEURON_RATES[AI_MODEL]).toBeDefined();
  });

  it('ALLOWED_MODELS has at least one entry', () => {
    expect(Object.keys(ALLOWED_MODELS).length).toBeGreaterThan(0);
  });

  it('RATE_LIMIT_PER_MINUTE is a positive integer', () => {
    expect(RATE_LIMIT_PER_MINUTE).toBeGreaterThan(0);
    expect(Number.isInteger(RATE_LIMIT_PER_MINUTE)).toBe(true);
  });

  it('MAX_TOKENS_LIMIT is a positive integer', () => {
    expect(MAX_TOKENS_LIMIT).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TOKENS_LIMIT)).toBe(true);
  });
});
