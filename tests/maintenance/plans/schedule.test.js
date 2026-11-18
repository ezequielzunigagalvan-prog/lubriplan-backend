import { describe, it, expect } from "vitest";
import { computeNextDueAt, nextCycleAfter, isTimeSchedulable } from "../../../src/modules/maintenance/plans/schedule.js";

// Fechas a medianoche de Ciudad de México (UTC-6) expresadas en UTC
const mx = (ymd) => new Date(`${ymd}T06:00:00.000Z`);
const day = (d) => d.toISOString().slice(0, 10);

const monthly = { triggerType: "TIME", frequencyUnit: "MONTH", frequencyEvery: 1, scheduleMode: "FIXED" };

describe("plans/schedule", () => {
  describe("isTimeSchedulable", () => {
    it("requires TIME trigger, anchor and frequency", () => {
      expect(isTimeSchedulable({ ...monthly, anchorDate: mx("2026-01-01") })).toBe(true);
      expect(isTimeSchedulable({ ...monthly, anchorDate: null })).toBe(false);
      expect(isTimeSchedulable({ ...monthly, triggerType: "METER", anchorDate: mx("2026-01-01") })).toBe(false);
      expect(isTimeSchedulable({ ...monthly, frequencyUnit: null, anchorDate: mx("2026-01-01") })).toBe(false);
    });
  });

  describe("computeNextDueAt (FIXED)", () => {
    const plan = { ...monthly, anchorDate: mx("2026-10-17") };

    it("returns the anchor when it is in the future", () => {
      expect(day(computeNextDueAt({ ...plan, anchorDate: mx("2026-12-05") }, new Date("2026-11-18T02:00:00Z")))).toBe("2026-12-05");
    });

    it("returns today's cycle when it falls today (local time)", () => {
      // 2026-11-17 20:00 en CDMX = 2026-11-18T02:00Z
      expect(day(computeNextDueAt(plan, new Date("2026-11-18T02:00:00Z")))).toBe("2026-11-17");
    });

    it("skips to the next cycle once the day has passed", () => {
      expect(day(computeNextDueAt(plan, new Date("2026-11-19T12:00:00Z")))).toBe("2026-12-17");
    });

    it("does not drift on month ends (day 31)", () => {
      const p = { ...monthly, anchorDate: mx("2026-01-31") };
      expect(day(computeNextDueAt(p, new Date("2026-03-05T18:00:00Z")))).toBe("2026-03-31");
    });

    it("handles old anchors with daily frequency quickly", () => {
      const p = { ...monthly, frequencyUnit: "DAY", anchorDate: mx("2020-01-01") };
      const start = Date.now();
      expect(day(computeNextDueAt(p, new Date("2026-11-18T18:00:00Z")))).toBe("2026-11-18");
      expect(Date.now() - start).toBeLessThan(200);
    });

    it("returns null for non time-based plans", () => {
      expect(computeNextDueAt({ ...plan, triggerType: "METER" })).toBeNull();
    });
  });

  describe("computeNextDueAt (FLOATING)", () => {
    const plan = { ...monthly, scheduleMode: "FLOATING", anchorDate: mx("2026-10-01") };

    it("uses the anchor when it has never been completed", () => {
      expect(day(computeNextDueAt(plan, new Date("2026-11-18T02:00:00Z")))).toBe("2026-10-01");
    });

    it("counts from the last completion date", () => {
      const p = { ...plan, lastCompletedAt: new Date("2026-11-10T20:00:00Z") };
      expect(day(computeNextDueAt(p, new Date("2026-11-18T02:00:00Z")))).toBe("2026-12-10");
    });
  });

  describe("nextCycleAfter", () => {
    it("FIXED monthly keeps the anchor day after short months", () => {
      const p = { ...monthly, anchorDate: mx("2026-01-31") };
      const seq = [];
      let d = p.anchorDate;
      for (let i = 0; i < 4; i++) {
        d = nextCycleAfter(p, d);
        seq.push(day(d));
      }
      expect(seq).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
    });

    it("FIXED weekly from an old anchor", () => {
      const p = { ...monthly, frequencyUnit: "WEEK", frequencyEvery: 1, anchorDate: mx("2025-01-06") };
      expect(day(nextCycleAfter(p, mx("2026-11-23")))).toBe("2026-11-30");
    });

    it("FLOATING simply adds the frequency", () => {
      const p = { ...monthly, scheduleMode: "FLOATING", frequencyUnit: "WEEK", frequencyEvery: 2, anchorDate: mx("2026-01-01") };
      expect(day(nextCycleAfter(p, mx("2026-11-17")))).toBe("2026-12-01");
    });
  });
});
