import assert from "node:assert/strict";
import test from "node:test";

import { SimulatedClock } from "../src/clock.js";
import { Service } from "../src/service.js";
import { Store } from "../src/store.js";
import { completeRequiredSteps, makeService, openPlan } from "./support.js";

test("推进模拟时钟可观察到复查逾期升级", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);

  const early = service.advanceClock({ seconds: 3600 });
  assert.equal(early.newEscalations.length, 0);
  assert.deepEqual(early.dueRechecks, [plan.planId]);

  const late = service.advanceClock({ seconds: 24 * 3600 });
  assert.equal(late.newEscalations.length, 1);
  assert.equal(late.newEscalations[0].type, "recheck_overdue");
  assert.equal(late.newEscalations[0].zoneId, "hall");

  const again = service.advanceClock({ seconds: 3600 });
  assert.equal(again.newEscalations.length, 0);

  const zone = service.zoneStatus({ zoneId: "hall" });
  assert.equal(zone.escalations.length, 1);
  assert.equal(zone.escalations[0].type, "recheck_overdue");
});

test("复查通过后逾期升级关闭", () => {
  const { service } = makeService();
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  service.advanceClock({ seconds: 25 * 3600 });
  assert.equal(service.listEscalations({ venueId: "venue-1" }).length, 1);

  service.recordRecheck({ planId: plan.planId, outcome: "passed" });
  const open = service.listEscalations({ venueId: "venue-1" }).filter((item) => item.status === "open");
  assert.equal(open.length, 0);
});

test("重启服务后原计时依据不重置", () => {
  const { service, store } = makeService();
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  service.advanceClock({ seconds: 2 * 3600 });
  const before = service.advanceClock({ seconds: 0 }).now;

  // 模拟重启：用同一存储重建时钟与服务，时间与已完成时点保持不变。
  const restarted = new Service({ store, clock: new SimulatedClock(store) });
  assert.equal(restarted.advanceClock({ seconds: 0 }).now, before);

  const result = restarted.advanceClock({ seconds: 22 * 3600 });
  assert.equal(result.newEscalations.length, 1);
  assert.equal(result.newEscalations[0].planId, plan.planId);
});

test("从快照恢复后升级与区域状态保持一致", () => {
  const { service, store } = makeService();
  const { plan } = openPlan(service);
  completeRequiredSteps(service, plan.planId);
  service.advanceClock({ seconds: 26 * 3600 });

  const restoredStore = Store.restore(store.snapshot());
  // 快照中已含模拟时钟，恢复后应直接可读。
  const restored = new Service({ store: restoredStore, clock: new SimulatedClock(restoredStore) });
  assert.equal(restored.advanceClock({ seconds: 0 }).now, service.advanceClock({ seconds: 0 }).now);

  const zone = restored.zoneStatus({ zoneId: "hall" });
  assert.equal(zone.state, "closed");
  assert.equal(zone.escalations.length, 1);
});
