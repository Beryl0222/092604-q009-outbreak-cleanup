import assert from "node:assert/strict";
import test from "node:test";

import { lunchClue, makeService } from "./support.js";

test("电话、门店工单、物业记录聚合为同一起事件且保留各自来源", () => {
  const { service } = makeService();
  const first = service.reportClue(lunchClue("clue-phone"));
  const second = service.reportClue(
    lunchClue("clue-order", {
      occurredAt: "2026-10-01T15:00:00.000Z",
      source: { type: "store_work_order", ref: "wo-7" },
      symptoms: { vomiting: 1, diarrhea: 2 },
    }),
  );
  const third = service.reportClue(
    lunchClue("clue-property", {
      occurredAt: "2026-10-01T16:30:00.000Z",
      source: { type: "property_record", ref: "pr-3" },
      symptoms: { vomiting: 0, diarrhea: 1 },
    }),
  );

  assert.equal(first.merged, false);
  assert.equal(second.merged, true);
  assert.equal(third.merged, true);
  assert.equal(second.incidentId, first.incidentId);
  assert.equal(third.incidentId, first.incidentId);

  const incident = service.getIncident({ incidentId: first.incidentId });
  assert.equal(incident.clues.length, 3);
  assert.deepEqual(
    incident.clues.map((clue) => [clue.source.type, clue.source.ref]),
    [
      ["phone", "caller-1"],
      ["store_work_order", "wo-7"],
      ["property_record", "pr-3"],
    ],
  );
  assert.equal(incident.windowStart, "2026-10-01T14:00:00.000Z");
  assert.equal(incident.windowEnd, "2026-10-01T16:30:00.000Z");

  const zone = service.zoneStatus({ zoneId: "hall" });
  assert.equal(zone.state, "closed");
  assert.equal(zone.reasons.at(-1).action, "closed");
  assert.equal(zone.reasons.at(-1).incidentId, first.incidentId);
});

test("不同就餐批次的线索不合并，避免遗漏批次", () => {
  const { service } = makeService();
  const lunch = service.reportClue(lunchClue("clue-lunch"));
  const dinner = service.reportClue(
    lunchClue("clue-dinner", {
      zoneId: "kitchen",
      mealBatchId: "batch-dinner",
      occurredAt: "2026-10-01T20:00:00.000Z",
      source: { type: "store_work_order", ref: "wo-9" },
    }),
  );
  assert.notEqual(dinner.incidentId, lunch.incidentId);
  assert.equal(dinner.merged, false);
  assert.equal(service.zoneStatus({ zoneId: "kitchen" }).state, "closed");
});

test("超出发生时段窗口的同批次线索另立事件", () => {
  const { service } = makeService();
  const first = service.reportClue(lunchClue("clue-early"));
  service.advanceClock({ seconds: 3 * 3600 });
  const late = service.reportClue(lunchClue("clue-late", { occurredAt: "2026-10-01T23:30:00.000Z" }));
  assert.notEqual(late.incidentId, first.incidentId);
});

test("未知就餐批次的线索按空批次聚合", () => {
  const { service } = makeService();
  const a = service.reportClue(lunchClue("clue-a", { mealBatchId: null }));
  const b = service.reportClue(lunchClue("clue-b", { mealBatchId: null, occurredAt: "2026-10-01T15:00:00.000Z" }));
  assert.equal(b.incidentId, a.incidentId);
});

test("线索不得携带医学诊断", () => {
  const { service } = makeService();
  assert.throws(() => service.reportClue(lunchClue("clue-dx", { diagnosis: "诺如病毒感染" })), /医学诊断/);
});

test("未登记的就餐批次与来源类型被拒绝", () => {
  const { service } = makeService();
  assert.throws(() => service.reportClue(lunchClue("clue-x", { mealBatchId: "batch-ghost" })), /未登记/);
  assert.throws(() => service.reportClue(lunchClue("clue-y", { source: { type: "rumor" } })), /来源类型/);
});
