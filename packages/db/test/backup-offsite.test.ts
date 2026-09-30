import { describe, expect, it } from "vitest";
import { backupsToPrune } from "../src/backup-offsite.js";

const day = (iso: string) => ({ key: `backups/slai-${iso}.dump`, at: new Date(`${iso}T03:00:00Z`) });

describe("backup retention", () => {
  it("keeps every backup for dailyDays, then the first of each month for monthlyMonths", () => {
    const now = new Date("2026-09-30T04:00:00Z");
    const objects = [
      day("2026-09-29"),
      day("2026-09-01"),
      day("2026-08-28"), // within 35 days
      day("2026-08-20"), // older than 35 days, not first of its month
      day("2026-08-02"), // first of August: monthly
      day("2026-08-03"),
      day("2025-10-05"), // first of October 2025: within 12 months
      day("2025-08-01"), // first of its month but older than 12 months
    ];
    const doomed = backupsToPrune(objects, now, { dailyDays: 35, monthlyMonths: 12 });
    expect(doomed.sort()).toEqual(
      ["backups/slai-2025-08-01.dump", "backups/slai-2026-08-03.dump", "backups/slai-2026-08-20.dump"].sort(),
    );
  });

  it("never deletes anything recent, even with many backups", () => {
    const now = new Date("2026-09-30T04:00:00Z");
    const objects = Array.from({ length: 30 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`));
    expect(backupsToPrune(objects, now)).toEqual([]);
  });
});
