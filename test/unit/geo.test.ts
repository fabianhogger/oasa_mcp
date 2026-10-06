import { describe, expect, it } from 'vitest';
import { bbox, haversineM, inAttica, pathLengthKm, simplify } from '../../src/geo.js';

describe('haversineM', () => {
  it('matches known Athens distances', () => {
    // Syntagma to Omonia: ~950 m along the straight line.
    expect(haversineM(37.9755, 23.7348, 37.9838, 23.7275)).toBeCloseTo(1130, -2);
    // Omonia to Piraeus: ~8.6 km.
    expect(haversineM(37.9838, 23.7275, 37.9475, 23.6425) / 1000).toBeCloseTo(8.4, 0);
  });

  it('is zero for a point against itself', () => {
    expect(haversineM(37.9838, 23.7275, 37.9838, 23.7275)).toBe(0);
  });

  it('agrees with the degree-based distance getClosestStops reports', () => {
    // Fixture: Omonia query point to stop 60134, upstream distance 0.00059 deg.
    const m = haversineM(37.9838, 23.7275, 37.9833682, 23.7279031);
    expect(m).toBeGreaterThan(10);
    expect(m).toBeLessThan(120); // i.e. ~50 m, not 0.00059 of anything
  });
});

describe('inAttica', () => {
  it('accepts Athens and rejects a transposed coordinate', () => {
    expect(inAttica(37.9838, 23.7275)).toBe(true);
    // Transposing lat/lon lands in Iraq — the canary this exists to catch.
    expect(inAttica(23.7275, 37.9838)).toBe(false);
  });
});

describe('pathLengthKm and bbox', () => {
  const pts = [
    { lat: 37.98, lon: 23.73 },
    { lat: 37.99, lon: 23.74 },
    { lat: 38.0, lon: 23.75 },
  ];

  it('sums segment lengths', () => {
    expect(pathLengthKm(pts)).toBeGreaterThan(2);
    expect(pathLengthKm(pts)).toBeLessThan(4);
    expect(pathLengthKm([])).toBe(0);
  });

  it('bounds the points', () => {
    expect(bbox(pts)).toEqual([37.98, 23.73, 38.0, 23.75]);
    expect(bbox([])).toBeNull();
  });
});

describe('simplify', () => {
  const line = Array.from({ length: 500 }, (_, i) => ({
    lat: 37.9 + i * 0.001,
    lon: 23.7 + Math.sin(i / 20) * 0.01,
  }));

  it('respects the point budget', () => {
    const out = simplify(line, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.length).toBeGreaterThan(5);
  });

  it('always keeps the endpoints', () => {
    const out = simplify(line, 20);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(line[line.length - 1]);
  });

  it('passes short inputs through untouched', () => {
    const short = line.slice(0, 10);
    expect(simplify(short, 60)).toEqual(short);
  });
});
