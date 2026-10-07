/** 聚集性胃肠事件清消的应用服务。 */
import { Clock } from "./clock.js";
import { Store } from "./store.js";
import {
  SOURCE_TYPES,
  clueMatchesIncident,
  evaluatePlan,
  evaluateReturnToWork,
} from "./domain.js";

function need(condition, message) {
  if (!condition) throw new Error(message);
}

export class Service {
  constructor({ store = new Store(), clock = new Clock(), aggregationWindowHours = 6 } = {}) {
    this.store = store;
    this.clock = clock;
    this.aggregationWindowHours = aggregationWindowHours;
  }

  health() {
    return { service: "outbreak_cleanup", status: "ok" };
  }

  register(recordId, ownerId) {
    const record = { recordId, ownerId, state: "draft", revision: 1, createdAt: this.clock.now() };
    this.store.add(record);
    return structuredClone(record);
  }

  find(recordId) {
    return this.store.get(recordId);
  }

  _nextId(prefix) {
    const seq = (this.store.getMeta(`seq:${prefix}`) ?? 0) + 1;
    this.store.setMeta(`seq:${prefix}`, seq);
    return `${prefix}-${seq}`;
  }

  _venue(venueId) {
    const venue = this.store.getFrom("venues", venueId);
    need(venue, `场所不存在: ${venueId}`);
    return venue;
  }

  _zone(zoneId) {
    const zone = this.store.getFrom("zones", zoneId);
    need(zone, `场所分区不存在: ${zoneId}`);
    return zone;
  }

  _incident(incidentId) {
    const incident = this.store.getFrom("incidents", incidentId);
    need(incident, `事件不存在: ${incidentId}`);
    return incident;
  }

  _plan(planId) {
    const plan = this.store.getFrom("plans", planId);
    need(plan, `处置方案不存在: ${planId}`);
    return plan;
  }

  _incidentZoneIds(incident) {
    const zoneIds = new Set();
    for (const clueId of incident.clueIds) {
      const clue = this.store.getFrom("clues", clueId);
      if (clue) zoneIds.add(clue.zoneId);
    }
    return [...zoneIds];
  }

  _openIncidentsForZone(zoneId) {
    return this.store.filter(
      "incidents",
      (incident) => incident.status === "open" && this._incidentZoneIds(incident).includes(zoneId),
    );
  }

  // --- 登记 ---

  registerVenue({ venueId, name = null, zones = [], storeManagerId }) {
    need(venueId, "场所编号缺失");
    need(storeManagerId, "门店经理标识缺失");
    need(!this.store.getFrom("venues", venueId), `场所已存在: ${venueId}`);
    const venue = { venueId, name: name ?? venueId, storeManagerId, zoneIds: [...zones], createdAt: this.clock.now() };
    this.store.put("venues", venueId, venue);
    for (const zoneId of zones) {
      need(!this.store.getFrom("zones", zoneId), `场所分区已存在: ${zoneId}`);
      this.store.put("zones", zoneId, { zoneId, venueId, state: "open", reasons: [] });
    }
    return venue;
  }

  registerRule(rule) {
    need(rule && rule.ruleId, "规则编号缺失");
    need(Number.isInteger(rule.version), "规则版本缺失");
    need(rule.effectiveFrom && !Number.isNaN(Date.parse(rule.effectiveFrom)), "规则生效时间无效");
    need(Array.isArray(rule.steps) && rule.steps.length > 0, "规则步骤缺失");
    need(rule.foodHandlerReturn && Number.isFinite(rule.foodHandlerReturn.symptomFreeHours), "返岗规则缺失");
    const key = `${rule.ruleId}@${rule.version}`;
    need(!this.store.getFrom("rules", key), `规则版本已存在: ${key}`);
    const stored = {
      ruleId: rule.ruleId,
      version: rule.version,
      agent: rule.agent ?? null, // 疑似病原假设，仅用于选择清消标准，不构成医学诊断
      venueIds: rule.venueIds ?? null,
      effectiveFrom: rule.effectiveFrom,
      effectiveUntil: rule.effectiveUntil ?? null,
      steps: rule.steps.map((step) => ({ ...step })),
      ppe: [...(rule.ppe ?? [])],
      foodHandlerReturn: { ...rule.foodHandlerReturn },
      recheckWithinHours: rule.recheckWithinHours ?? 24,
      registeredAt: this.clock.now(),
    };
    this.store.put("rules", key, stored);
    return stored;
  }

  registerMealBatch({ batchId, venueId, servedFrom, servedTo }) {
    need(batchId, "就餐批次编号缺失");
    this._venue(venueId);
    need(
      servedFrom && servedTo && !Number.isNaN(Date.parse(servedFrom)) && Date.parse(servedFrom) <= Date.parse(servedTo),
      "供餐时段无效",
    );
    need(!this.store.getFrom("batches", batchId), `就餐批次已存在: ${batchId}`);
    const batch = { batchId, venueId, servedFrom, servedTo, status: "pending", outcome: null, verifiedAt: null };
    this.store.put("batches", batchId, batch);
    return batch;
  }

  verifyMealBatch({ batchId, outcome }) {
    const batch = this.store.getFrom("batches", batchId);
    need(batch, `就餐批次不存在: ${batchId}`);
    need(["confirmed", "cleared"].includes(outcome), "批次核查结论无效");
    batch.status = outcome;
    batch.outcome = outcome;
    batch.verifiedAt = this.clock.now();
    this.store.put("batches", batchId, batch);
    return batch;
  }

  // --- 线索聚合 ---

  reportClue(input) {
    need(input && typeof input === "object", "线索内容缺失");
    need(!("diagnosis" in input), "本服务不作医学诊断，仅记录症状观察");
    const { clueId, venueId, zoneId, occurredAt } = input;
    need(clueId, "线索编号缺失");
    this._venue(venueId);
    const zone = this._zone(zoneId);
    need(zone.venueId === venueId, `分区 ${zoneId} 不属于场所 ${venueId}`);
    need(SOURCE_TYPES.includes(input.source?.type), "线索来源类型不受支持");
    need(occurredAt && !Number.isNaN(Date.parse(occurredAt)), "发生时间无效");
    need(!this.store.getFrom("clues", clueId), `线索已存在: ${clueId}`);
    const mealBatchId = input.mealBatchId ?? null;
    if (mealBatchId) {
      const batch = this.store.getFrom("batches", mealBatchId);
      need(batch, `就餐批次未登记: ${mealBatchId}`);
      need(batch.venueId === venueId, `就餐批次 ${mealBatchId} 不属于场所 ${venueId}`);
    }
    const symptoms = { vomiting: 0, diarrhea: 0, ...(input.symptoms ?? {}) };
    need(
      Number.isFinite(symptoms.vomiting) && symptoms.vomiting >= 0 && Number.isFinite(symptoms.diarrhea) && symptoms.diarrhea >= 0,
      "症状观察数量无效",
    );
    const clue = {
      clueId,
      venueId,
      zoneId,
      mealBatchId,
      occurredAt,
      receivedAt: this.clock.now(),
      source: { type: input.source.type, ref: input.source.ref ?? null, reporter: input.source.reporter ?? null },
      symptoms,
      note: input.note ?? null,
    };
    this.store.put("clues", clueId, clue);

    const existing = this.store.filter("incidents", (incident) => clueMatchesIncident(incident, clue, this.aggregationWindowHours));
    let incident = existing[0] ?? null;
    const merged = incident !== null;
    if (!incident) {
      incident = {
        incidentId: this._nextId("incident"),
        venueId,
        mealBatchId,
        windowStart: occurredAt,
        windowEnd: occurredAt,
        clueIds: [],
        conflicts: [],
        status: "open",
        createdAt: this.clock.now(),
      };
    }
    incident.clueIds.push(clueId);
    if (Date.parse(occurredAt) < Date.parse(incident.windowStart)) incident.windowStart = occurredAt;
    if (Date.parse(occurredAt) > Date.parse(incident.windowEnd)) incident.windowEnd = occurredAt;
    this.store.put("incidents", incident.incidentId, incident);

    const current = this._zone(zoneId);
    if (current.state !== "closed") {
      current.state = "closed";
      current.reasons.push({
        at: this.clock.now(),
        by: clue.source.type,
        action: "closed",
        reason: "聚集性胃肠事件线索",
        incidentId: incident.incidentId,
      });
      this.store.put("zones", zoneId, current);
    }
    return { clue, incidentId: incident.incidentId, merged };
  }

  getIncident({ incidentId }) {
    const incident = this._incident(incidentId);
    const clues = incident.clueIds
      .map((clueId) => this.store.getFrom("clues", clueId))
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    return { ...incident, zoneIds: this._incidentZoneIds(incident), clues };
  }

  flagConflict({ incidentId, description, clueIds = [] }) {
    const incident = this._incident(incidentId);
    need(description, "冲突描述缺失");
    const conflict = {
      conflictId: this._nextId("conflict"),
      description,
      clueIds: [...clueIds],
      status: "open",
      raisedAt: this.clock.now(),
      resolvedAt: null,
      resolution: null,
    };
    incident.conflicts.push(conflict);
    this.store.put("incidents", incidentId, incident);
    return conflict;
  }

  resolveConflict({ incidentId, conflictId, resolution }) {
    const incident = this._incident(incidentId);
    const conflict = incident.conflicts.find((item) => item.conflictId === conflictId);
    need(conflict, `事实冲突不存在: ${conflictId}`);
    need(conflict.status === "open", "事实冲突已解决");
    need(resolution, "冲突解决说明缺失");
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedAt = this.clock.now();
    this.store.put("incidents", incidentId, incident);
    return conflict;
  }

  // --- 清消处置 ---

  _resolveRule(ruleId, version) {
    if (version != null) return this.store.getFrom("rules", `${ruleId}@${version}`);
    const candidates = this.store.all("rules").filter((rule) => rule.ruleId === ruleId);
    candidates.sort((a, b) => b.version - a.version);
    return candidates[0] ?? null;
  }

  _latestEffectiveRule(venueId) {
    const now = this.clock.now();
    const candidates = this.store.all("rules").filter(
      (rule) =>
        (!rule.venueIds || rule.venueIds.includes(venueId)) &&
        Date.parse(rule.effectiveFrom) <= Date.parse(now) &&
        (!rule.effectiveUntil || Date.parse(rule.effectiveUntil) > Date.parse(now)),
    );
    candidates.sort((a, b) => b.version - a.version);
    return candidates[0] ?? null;
  }

  startCleanup({ incidentId, zoneId, ruleId, version = null }) {
    const incident = this._incident(incidentId);
    need(incident.status === "open", "事件已关闭");
    const zone = this._zone(zoneId);
    need(zone.venueId === incident.venueId, `分区 ${zoneId} 不属于事件所在场所`);
    need(this._incidentZoneIds(incident).includes(zoneId), "分区不在事件影响范围内");
    const rule = this._resolveRule(ruleId, version);
    need(rule, `处置规则不存在: ${ruleId}`);
    need(!rule.venueIds || rule.venueIds.includes(incident.venueId), "处置规则不适用于该场所");
    const now = this.clock.now();
    need(Date.parse(rule.effectiveFrom) <= Date.parse(now), "处置规则尚未生效");
    need(!rule.effectiveUntil || Date.parse(rule.effectiveUntil) > Date.parse(now), "处置规则已过期");
    const duplicates = this.store.filter(
      "plans",
      (plan) => plan.incidentId === incidentId && plan.zoneId === zoneId && plan.state !== "closed",
    );
    need(duplicates.length === 0, "该事件在此分区已有进行中的处置方案");
    const plan = {
      planId: this._nextId("plan"),
      incidentId,
      zoneId,
      venueId: incident.venueId,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ruleSnapshot: {
        agent: rule.agent,
        steps: rule.steps.map((step) => ({ ...step })),
        ppe: [...rule.ppe],
        foodHandlerReturn: { ...rule.foodHandlerReturn },
        recheckWithinHours: rule.recheckWithinHours,
        effectiveUntil: rule.effectiveUntil,
      },
      ppeIssued: [...rule.ppe],
      steps: Object.fromEntries(rule.steps.map((step) => [step.key, { status: "pending" }])),
      state: "in_progress",
      createdAt: now,
      completedAt: null,
      recheck: null,
      rechecks: [],
      closedAt: null,
    };
    this.store.put("plans", plan.planId, plan);
    return plan;
  }

  recordStep({ planId, stepKey, status, disinfectant = null, contactMinutes = null, by = null }) {
    const plan = this._plan(planId);
    need(plan.state !== "closed", "处置方案已关闭");
    need(Object.hasOwn(plan.steps, stepKey), `方案中不存在步骤: ${stepKey}`);
    need(["done", "skipped"].includes(status), "步骤状态无效");
    const now = this.clock.now();
    plan.steps[stepKey] =
      status === "done" ? { status, at: now, by, disinfectant, contactMinutes } : { status, at: now, by };
    // 步骤在复查通过后又被改动时，原复查结论失效，必须重新复查。
    if (plan.recheck) plan.recheck = null;
    const requiredDone = plan.ruleSnapshot.steps.filter((step) => step.required).every((step) => plan.steps[step.key]?.status === "done");
    if (requiredDone) {
      if (plan.state === "in_progress") plan.completedAt = now;
      plan.state = "awaiting_recheck";
    } else {
      plan.state = "in_progress";
      plan.completedAt = null;
    }
    this.store.put("plans", planId, plan);
    return plan;
  }

  recordRecheck({ planId, outcome, note = null, by = null }) {
    const plan = this._plan(planId);
    need(plan.state === "awaiting_recheck", "方案尚未进入复查阶段");
    need(["passed", "failed"].includes(outcome), "复查结论无效");
    const now = this.clock.now();
    plan.recheck = { outcome, note, by, at: now };
    plan.rechecks.push(plan.recheck);
    if (outcome === "passed") {
      plan.state = "rechecked";
      this._closeEscalations(plan.planId, now);
    } else {
      plan.state = "in_progress";
      plan.completedAt = null;
    }
    this.store.put("plans", planId, plan);
    return plan;
  }

  inspectZone({ zoneId, by = null }) {
    const zone = this._zone(zoneId);
    const now = this.clock.now();
    const incidents = this._openIncidentsForZone(zoneId);
    const plans = this.store.filter("plans", (plan) => plan.zoneId === zoneId && plan.state !== "closed");
    if (zone.state === "open" && incidents.length === 0 && plans.length === 0) {
      return { zoneId, state: "open", gaps: [] };
    }
    const gaps = [];
    for (const incident of incidents) {
      const openConflicts = incident.conflicts.filter((conflict) => conflict.status === "open");
      if (openConflicts.length > 0) {
        gaps.push({ incidentId: incident.incidentId, gap: "unresolved_conflicts", conflicts: openConflicts.map((c) => c.conflictId) });
      }
    }
    for (const plan of plans) {
      for (const gap of evaluatePlan(plan, now)) {
        gaps.push({ planId: plan.planId, ...gap });
      }
    }
    if (gaps.length > 0) {
      zone.state = "closed";
      zone.reasons.push({ at: now, by, action: "kept_closed", reason: "复开检查未通过", gaps });
      this.store.put("zones", zoneId, zone);
      return { zoneId, state: "closed", gaps };
    }
    zone.state = "open";
    zone.reasons.push({
      at: now,
      by,
      action: "reopened",
      reason: "复开检查通过",
      plans: plans.map((plan) => plan.planId),
      rules: plans.map((plan) => ({ ruleId: plan.ruleId, version: plan.ruleVersion })),
    });
    this.store.put("zones", zoneId, zone);
    for (const plan of plans) {
      plan.state = "closed";
      plan.closedAt = now;
      this.store.put("plans", plan.planId, plan);
    }
    this._closeIncidentsIfClear(now);
    return { zoneId, state: "open", gaps: [] };
  }

  _closeIncidentsIfClear(now) {
    for (const incident of this.store.filter("incidents", (item) => item.status === "open")) {
      const zoneIds = this._incidentZoneIds(incident);
      const allOpen = zoneIds.every((zoneId) => this.store.getFrom("zones", zoneId)?.state === "open");
      if (allOpen) {
        incident.status = "closed";
        incident.closedAt = now;
        this.store.put("incidents", incident.incidentId, incident);
      }
    }
  }

  // --- 食品处理人员返岗 ---

  flagFoodHandler({ staffId, venueId, name = null, incidentId = null, symptomaticAt = null }) {
    this._venue(venueId);
    need(staffId, "人员编号缺失");
    let staff = this.store.getFrom("staff", staffId);
    if (!staff) staff = { staffId, venueId, name, restrictions: [], returnDecisions: [] };
    need(staff.venueId === venueId, "人员不属于该场所");
    let ruleRef = null;
    if (incidentId) {
      const plans = this.store.filter("plans", (plan) => plan.incidentId === incidentId);
      if (plans.length > 0) ruleRef = { ruleId: plans[0].ruleId, version: plans[0].ruleVersion };
    }
    if (!ruleRef) {
      const rule = this._latestEffectiveRule(venueId);
      need(rule, "无可用处置规则，无法登记返岗限制");
      ruleRef = { ruleId: rule.ruleId, version: rule.version };
    }
    const restriction = {
      restrictionId: this._nextId("restriction"),
      incidentId,
      symptomaticAt,
      ruleId: ruleRef.ruleId,
      ruleVersion: ruleRef.version,
      flaggedAt: this.clock.now(),
      active: true,
      liftedAt: null,
    };
    staff.restrictions.push(restriction);
    this.store.put("staff", staffId, staff);
    return restriction;
  }

  decideReturnToWork({ staffId, decidedBy = {}, symptomFreeSince = null }) {
    const staff = this.store.getFrom("staff", staffId);
    need(staff, `人员不存在: ${staffId}`);
    const venue = this._venue(staff.venueId);
    const restriction = staff.restrictions.find((item) => item.active);
    need(restriction, "该人员当前没有在岗限制");
    const rule = this.store.getFrom("rules", `${restriction.ruleId}@${restriction.ruleVersion}`);
    need(rule, "返岗评估所需规则版本不存在");
    const now = this.clock.now();
    const rejects = evaluateReturnToWork({ restriction, rule, decidedBy, venue, symptomFreeSince, now });
    const decision = {
      decidedAt: now,
      decidedBy: { actorId: decidedBy.actorId ?? null, role: decidedBy.role ?? null },
      symptomFreeSince,
      approved: rejects.length === 0,
      rejects,
    };
    staff.returnDecisions.push(decision);
    if (decision.approved) {
      restriction.active = false;
      restriction.liftedAt = now;
    }
    this.store.put("staff", staffId, staff);
    return decision;
  }

  // --- 时钟推进与逾期升级 ---

  advanceClock({ seconds }) {
    need(Number.isFinite(seconds) && seconds >= 0, "推进秒数无效");
    need(typeof this.clock.advance === "function", "当前时钟不支持推进");
    const now = this.clock.advance(seconds);
    const newEscalations = [];
    const dueRechecks = [];
    for (const plan of this.store.filter("plans", (item) => item.state === "awaiting_recheck")) {
      const overdueAt = Date.parse(plan.completedAt) + plan.ruleSnapshot.recheckWithinHours * 3_600_000;
      if (Date.parse(now) >= overdueAt) {
        const existing = this.store.filter(
          "escalations",
          (item) => item.planId === plan.planId && item.type === "recheck_overdue" && item.status === "open",
        );
        if (existing.length === 0) {
          const escalation = {
            escalationId: this._nextId("escalation"),
            type: "recheck_overdue",
            planId: plan.planId,
            zoneId: plan.zoneId,
            venueId: plan.venueId,
            incidentId: plan.incidentId,
            raisedAt: now,
            status: "open",
          };
          this.store.put("escalations", escalation.escalationId, escalation);
          newEscalations.push(escalation);
        }
      } else {
        dueRechecks.push(plan.planId);
      }
    }
    return { now, dueRechecks, newEscalations };
  }

  _closeEscalations(planId, now) {
    for (const escalation of this.store.filter("escalations", (item) => item.planId === planId && item.status === "open")) {
      escalation.status = "closed";
      escalation.closedAt = now;
      this.store.put("escalations", escalation.escalationId, escalation);
    }
  }

  listEscalations({ venueId = null } = {}) {
    return this.store.filter("escalations", (item) => !venueId || item.venueId === venueId);
  }

  // --- 查询 ---

  zoneStatus({ zoneId }) {
    const zone = this._zone(zoneId);
    const now = this.clock.now();
    const incidents = this._openIncidentsForZone(zoneId);
    const pendingMealBatches = [...new Set(incidents.map((incident) => incident.mealBatchId).filter(Boolean))]
      .map((batchId) => this.store.getFrom("batches", batchId))
      .filter((batch) => batch && batch.status === "pending")
      .map((batch) => ({ batchId: batch.batchId, servedFrom: batch.servedFrom, servedTo: batch.servedTo, status: batch.status }));
    return {
      zoneId,
      venueId: zone.venueId,
      state: zone.state,
      reasons: zone.reasons,
      pendingMealBatches,
      applicableRules: this._applicableRules(zone, now),
      openIncidents: incidents.map((incident) => ({
        incidentId: incident.incidentId,
        mealBatchId: incident.mealBatchId,
        windowStart: incident.windowStart,
        windowEnd: incident.windowEnd,
        clueCount: incident.clueIds.length,
        sources: incident.clueIds
          .map((clueId) => this.store.getFrom("clues", clueId)?.source.type)
          .filter(Boolean),
      })),
      escalations: this.store.filter("escalations", (item) => item.zoneId === zoneId && item.status === "open"),
      asOf: now,
    };
  }

  _applicableRules(zone, now) {
    const applicable = [];
    for (const rule of this.store.all("rules")) {
      if (rule.venueIds && !rule.venueIds.includes(zone.venueId)) continue;
      const effective = Date.parse(rule.effectiveFrom) <= Date.parse(now) && (!rule.effectiveUntil || Date.parse(now) < Date.parse(rule.effectiveUntil));
      if (effective) {
        applicable.push({
          ruleId: rule.ruleId,
          version: rule.version,
          agent: rule.agent,
          effectiveFrom: rule.effectiveFrom,
          effectiveUntil: rule.effectiveUntil,
          basis: "currently_effective",
        });
      }
    }
    for (const plan of this.store.filter("plans", (item) => item.zoneId === zone.zoneId && item.state !== "closed")) {
      if (!applicable.some((item) => item.ruleId === plan.ruleId && item.version === plan.ruleVersion)) {
        applicable.push({
          ruleId: plan.ruleId,
          version: plan.ruleVersion,
          agent: plan.ruleSnapshot.agent,
          effectiveFrom: null,
          effectiveUntil: plan.ruleSnapshot.effectiveUntil,
          basis: "referenced_by_plan",
        });
      }
    }
    return applicable;
  }
}
