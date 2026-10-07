import { SimulatedClock } from "../src/clock.js";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";
import { norovirusCleanupRule } from "../src/rules.js";

export const T0 = "2026-10-01T21:00:00.000Z";

export function makeService({ store = new Store(), startAt = T0, ruleOverrides = {} } = {}) {
  const clock = new SimulatedClock(store, startAt);
  const service = new Service({ store, clock });
  service.registerVenue({ venueId: "venue-1", name: "团餐点一店", zones: ["hall", "kitchen"], storeManagerId: "mgr-1" });
  service.registerRule(
    norovirusCleanupRule({
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      ...ruleOverrides,
    }),
  );
  service.registerMealBatch({ batchId: "batch-lunch", venueId: "venue-1", servedFrom: "2026-10-01T11:00:00.000Z", servedTo: "2026-10-01T13:00:00.000Z" });
  service.registerMealBatch({ batchId: "batch-dinner", venueId: "venue-1", servedFrom: "2026-10-01T17:00:00.000Z", servedTo: "2026-10-01T19:00:00.000Z" });
  return { service, store, clock };
}

export function lunchClue(clueId, overrides = {}) {
  return {
    clueId,
    venueId: "venue-1",
    zoneId: "hall",
    mealBatchId: "batch-lunch",
    occurredAt: "2026-10-01T14:00:00.000Z",
    source: { type: "phone", ref: "caller-1" },
    symptoms: { vomiting: 2, diarrhea: 1 },
    ...overrides,
  };
}

/** 报告一条午餐批次线索并开出处置方案。 */
export function openPlan(service, clueId = "clue-1") {
  const reported = service.reportClue(lunchClue(clueId));
  const plan = service.startCleanup({ incidentId: reported.incidentId, zoneId: "hall", ruleId: "norovirus-cleanup" });
  return { incidentId: reported.incidentId, plan };
}

/** 把方案的全部必需步骤按合规方式记录完成。 */
export function completeRequiredSteps(service, planId) {
  service.recordStep({ planId, stepKey: "isolate", status: "done" });
  service.recordStep({ planId, stepKey: "remove_contaminant", status: "done" });
  service.recordStep({ planId, stepKey: "disinfect", status: "done", disinfectant: "chlorine", contactMinutes: 30 });
}
