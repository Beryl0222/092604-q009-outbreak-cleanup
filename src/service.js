/** 聚集性胃肠事件清消的应用服务。 */
import { ManualClock } from "./clock.js";
import { Store } from "./store.js";

const DEFAULT_AGGREGATION_WINDOW_MINUTES = 48 * 60;
const DEFAULT_RECHECK_INTERVAL_MINUTES = 240;
const DEFAULT_QUALIFIED_ROLES = ["food_safety_officer", "public_health_officer"];
const CLUE_SOURCES = ["phone", "work_order", "property"];

const ms = (iso) => Date.parse(iso);

export class Service {
  constructor({ store = new Store(), clock } = {}) {
    this.store = store;
    this.clock = clock ?? new ManualClock(store);
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

  // ---- 处置规则 ----

  /** 登记一条带有效期的处置规则。 */
  registerRule(rule) {
    if (!rule?.ruleId || !rule?.version) throw new Error("规则编号或版本缺失");
    if (!Array.isArray(rule.steps) || rule.steps.length === 0) throw new Error("规则缺少方案步骤");
    if (!rule.steps.some((s) => s.key)) throw new Error("规则缺少关键步骤");
    if (!Array.isArray(rule.disinfection?.acceptedAgents) || rule.disinfection.acceptedAgents.length === 0) {
      throw new Error("规则缺少消毒剂要求");
    }
    if (rule.disinfection.acceptedAgents.includes("alcohol_wipe")) {
      throw new Error("酒精擦拭不能认作满足诺如病毒清消要求");
    }
    if (!(rule.disinfection.contactMinutes > 0)) throw new Error("规则缺少作用时长");
    if (Number.isNaN(ms(rule.effectiveFrom)) || Number.isNaN(ms(rule.effectiveTo))) {
      throw new Error("规则有效期缺失");
    }
    const record = { ...structuredClone(rule), recordId: `rule:${rule.ruleId}@${rule.version}` };
    this.store.put(record.recordId, record);
    return structuredClone(record);
  }

  /** 查找某一时刻适用的规则（版本最高者优先）。 */
  applicableRule(atIso) {
    const at = ms(atIso);
    const rules = this.store
      .all()
      .filter(([key]) => key.startsWith("rule:"))
      .map(([, value]) => value)
      .filter((r) => ms(r.effectiveFrom) <= at && at <= ms(r.effectiveTo));
    rules.sort((a, b) => b.version - a.version);
    return rules[0] ?? null;
  }

  // ---- 线索聚合 ----

  /**
   * 登记一条呕吐/腹泻线索，并按共同就餐、发生时段和场所分区聚合到事件。
   * 每条线索的来源保留在事件中；本服务不作医学诊断。
   */
  reportClue(clue) {
    if (!clue || typeof clue !== "object") throw new Error("线索内容缺失");
    if ("diagnosis" in clue || "suspectedDiagnosis" in clue) throw new Error("本服务不作医学诊断");
    const { clueId, source, siteId, zoneId, mealBatchId, occurredAt } = clue;
    if (!CLUE_SOURCES.includes(source)) throw new Error("未知线索来源");
    if (!clueId || !siteId || !zoneId || !mealBatchId || !occurredAt) throw new Error("线索字段不完整");
    if (Number.isNaN(ms(occurredAt))) throw new Error("发生时段无法解析");

    const now = this.clock.now();
    const rule = this.applicableRule(occurredAt) ?? this.applicableRule(now);
    const windowMs = (rule?.aggregationWindowMinutes ?? DEFAULT_AGGREGATION_WINDOW_MINUTES) * 60000;
    const t = ms(occurredAt);

    let event = this.store
      .all()
      .filter(([key]) => key.startsWith("event:"))
      .map(([, value]) => value)
      .filter((e) => e.state === "open" && e.siteId === siteId && e.zoneId === zoneId)
      .find((e) => ms(e.windowStart) - windowMs <= t && t <= ms(e.windowEnd) + windowMs);

    if (!event) {
      const eventId = this.#nextId("evt");
      event = {
        recordId: `event:${eventId}`,
        eventId,
        siteId,
        zoneId,
        state: "open",
        clues: [],
        mealBatches: [],
        conflicts: [],
        windowStart: occurredAt,
        windowEnd: occurredAt,
        openedAt: now,
      };
    } else {
      event.windowStart = new Date(Math.min(ms(event.windowStart), t)).toISOString();
      event.windowEnd = new Date(Math.max(ms(event.windowEnd), t)).toISOString();
    }

    event.clues.push({ clueId, source, occurredAt, symptoms: clue.symptoms ?? null, receivedAt: now });

    const batch = event.mealBatches.find((b) => b.batchId === mealBatchId);
    if (batch) {
      batch.sources.push(source);
      batch.clueIds.push(clueId);
      if (Math.abs(t - ms(batch.firstSeenAt)) > windowMs) {
        this.#addConflict(event, "time_inconsistent", `就餐批次 ${mealBatchId} 的报告时间相互矛盾`, mealBatchId);
      }
    } else {
      event.mealBatches.push({ batchId: mealBatchId, status: "pending", sources: [source], clueIds: [clueId], firstSeenAt: occurredAt });
      if (event.mealBatches.length > 1) {
        this.#addConflict(event, "meal_batch_mismatch", `就餐批次 ${mealBatchId} 与事件既有批次不一致，需核查`, mealBatchId);
      }
    }
    this.store.put(event.recordId, event);

    const zone = this.#closeZone(event, now, rule);
    return { event: structuredClone(event), zone: structuredClone(zone) };
  }

  /** 核查就餐批次；全部批次核查一致后，批次不一致冲突自动解除。 */
  verifyBatch(eventId, mealBatchId) {
    const event = this.#event(eventId);
    const batch = event.mealBatches.find((b) => b.batchId === mealBatchId);
    if (!batch) throw new Error("就餐批次不存在");
    batch.status = "verified";
    if (event.mealBatches.every((b) => b.status === "verified")) {
      for (const conflict of event.conflicts) {
        if (conflict.type === "meal_batch_mismatch" && conflict.status === "unresolved") {
          conflict.status = "resolved";
          conflict.resolution = "就餐批次已核查一致";
          conflict.resolvedAt = this.clock.now();
        }
      }
    }
    this.store.put(event.recordId, event);
    return structuredClone(event);
  }

  /** 以书面说明解决一桩事实冲突。 */
  resolveConflict(eventId, conflictId, resolution) {
    if (!resolution) throw new Error("冲突解决说明缺失");
    const event = this.#event(eventId);
    const conflict = event.conflicts.find((c) => c.conflictId === conflictId);
    if (!conflict) throw new Error("事实冲突不存在");
    conflict.status = "resolved";
    conflict.resolution = resolution;
    conflict.resolvedAt = this.clock.now();
    this.store.put(event.recordId, event);
    return structuredClone(conflict);
  }

  // ---- 处置方案 ----

  /** 依据当前适用的已登记规则，为事件建立处置方案。 */
  startPlan(eventId) {
    const event = this.#event(eventId);
    const now = this.clock.now();
    const rule = this.applicableRule(now);
    if (!rule) throw new Error("当前时间无已登记且有效的处置规则");

    const existing = this.#activePlan(eventId);
    if (existing) {
      if (ms(existing.ruleSnapshot.effectiveTo) >= ms(now)) throw new Error("已存在进行中的处置方案");
      existing.status = "superseded";
      this.store.put(existing.recordId, existing);
    }

    const planId = this.#nextId("plan");
    const plan = {
      recordId: `plan:${planId}`,
      planId,
      eventId,
      status: "active",
      createdAt: now,
      ruleSnapshot: {
        ruleId: rule.ruleId,
        version: rule.version,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
      },
      steps: rule.steps.map((s) => ({ stepId: s.stepId, kind: s.kind, key: !!s.key, title: s.title ?? s.stepId, status: "pending" })),
      disinfection: { acceptedAgents: [...rule.disinfection.acceptedAgents], contactMinutes: rule.disinfection.contactMinutes },
      recheckIntervalMinutes: rule.recheckIntervalMinutes ?? DEFAULT_RECHECK_INTERVAL_MINUTES,
    };
    this.store.put(plan.recordId, plan);

    const zone = this.#zone(event.zoneId);
    zone.recheckIntervalMinutes = plan.recheckIntervalMinutes;
    zone.recheckDueAt = new Date(ms(now) + plan.recheckIntervalMinutes * 60000).toISOString();
    this.store.put(zone.recordId, zone);
    return structuredClone(plan);
  }

  /** 开始一个方案步骤；消毒步骤须使用规则允许的消毒剂。 */
  beginStep(eventId, stepId, { agent } = {}) {
    const plan = this.#activePlan(eventId);
    if (!plan) throw new Error("处置方案未建立");
    const step = plan.steps.find((s) => s.stepId === stepId);
    if (!step) throw new Error("方案步骤不存在");
    if (step.status !== "pending") throw new Error("方案步骤已开始或完成");

    const now = this.clock.now();
    if (step.kind === "disinfection") {
      if (agent === "alcohol_wipe") throw new Error("酒精擦拭不能认作满足诺如病毒清消要求");
      if (!plan.disinfection.acceptedAgents.includes(agent)) throw new Error("消毒剂不在已登记规则允许范围内");
      step.agent = agent;
      step.appliedAt = now;
    }
    step.status = "in_progress";
    step.startedAt = now;
    this.store.put(plan.recordId, plan);
    return structuredClone(plan);
  }

  /** 完成一个方案步骤；消毒步骤须满足规则要求的作用时长。 */
  completeStep(eventId, stepId) {
    const plan = this.#activePlan(eventId);
    if (!plan) throw new Error("处置方案未建立");
    const step = plan.steps.find((s) => s.stepId === stepId);
    if (!step) throw new Error("方案步骤不存在");
    if (step.status !== "in_progress") throw new Error("方案步骤未在进行中");

    const now = this.clock.now();
    if (step.kind === "disinfection") {
      if (ms(now) - ms(step.appliedAt) < plan.disinfection.contactMinutes * 60000) {
        throw new Error("作用时间不足");
      }
      step.contactSatisfied = true;
    }
    step.status = "completed";
    step.completedAt = now;
    this.store.put(plan.recordId, plan);
    return structuredClone(plan);
  }

  // ---- 复开检查 ----

  /**
   * 复开检查。事实冲突未解决、关键步骤跳过、作用时间不足或方案过期时，
   * 区域继续关闭；全部满足且检查通过方可复开。
   */
  inspectZone(zoneId, { result = "pass", inspector = null } = {}) {
    const zone = this.#zone(zoneId);
    const now = this.clock.now();
    const blockers = this.reopenBlockers(zoneId);
    const inspection = { result, inspector, at: now, blockers };
    zone.inspections = [...(zone.inspections ?? []), inspection];

    if (result === "pass" && blockers.length === 0) {
      zone.state = "open";
      zone.reasons.push({ type: "reopened", reason: "复开检查通过", at: now });
      zone.recheckDueAt = null;
      for (const eventId of zone.eventIds) {
        const event = this.store.get(`event:${eventId}`);
        if (event?.state === "open") {
          event.state = "resolved";
          event.resolvedAt = now;
          this.store.put(event.recordId, event);
        }
      }
    }
    this.store.put(zone.recordId, zone);
    return { zone: structuredClone(zone), inspection };
  }

  /** 计算区域当前无法复开的原因列表。 */
  reopenBlockers(zoneId) {
    const zone = this.#zone(zoneId);
    const now = this.clock.now();
    const blockers = [];
    const events = zone.eventIds.map((id) => this.store.get(`event:${id}`)).filter((e) => e && e.state === "open");
    for (const event of events) {
      if (event.conflicts.some((c) => c.status === "unresolved")) {
        blockers.push(`事实冲突未解决:${event.eventId}`);
      }
      const plan = this.#activePlan(event.eventId);
      if (!plan) {
        blockers.push(`处置方案未建立:${event.eventId}`);
        continue;
      }
      if (plan.steps.some((s) => s.key && s.status !== "completed")) {
        blockers.push(`关键步骤跳过:${event.eventId}`);
      }
      const disinfection = plan.steps.find((s) => s.kind === "disinfection");
      if (disinfection?.status === "completed" && !disinfection.contactSatisfied) {
        blockers.push(`作用时间不足:${event.eventId}`);
      }
      if (ms(plan.ruleSnapshot.effectiveTo) < ms(now)) {
        blockers.push(`方案过期:${event.eventId}`);
      }
    }
    return blockers;
  }

  // ---- 食品处理人员返岗 ----

  /** 返岗决定必须由独立于门店经理的合格角色作出。 */
  decideReturn({ handlerId, siteId = null, decision, decidedBy } = {}) {
    if (!handlerId || !decision) throw new Error("返岗决定字段不完整");
    const role = decidedBy?.role;
    if (!role) throw new Error("返岗决定缺少决定角色");
    if (role === "store_manager") throw new Error("返岗决定须由独立于门店经理的合格角色参与");
    const rule = this.applicableRule(this.clock.now());
    const qualified = rule?.returnToWork?.qualifiedRoles ?? DEFAULT_QUALIFIED_ROLES;
    if (!qualified.includes(role)) throw new Error("返岗决定角色不具备已登记资质");

    const record = {
      recordId: `return:${handlerId}`,
      handlerId,
      siteId,
      decision,
      decidedBy,
      decidedAt: this.clock.now(),
      ruleVersion: rule?.version ?? null,
    };
    this.store.put(record.recordId, record);
    return structuredClone(record);
  }

  // ---- 模拟时钟、复查与逾期升级 ----

  /** 推进模拟时钟；复查逾期的关闭区域逐级升级。 */
  advanceClock(minutes) {
    if (!(minutes > 0)) throw new Error("推进时长必须为正数");
    if (typeof this.clock.advance !== "function") throw new Error("当前时钟不支持推进");
    const now = this.clock.advance(minutes);
    const escalations = [];
    for (const [, zone] of this.store.all().filter(([key]) => key.startsWith("zone:"))) {
      if (zone.state !== "closed" || !zone.recheckDueAt) continue;
      while (ms(zone.recheckDueAt) < ms(now)) {
        const escalation = {
          level: zone.escalations.length + 1,
          reason: "复查逾期升级",
          at: zone.recheckDueAt,
          eventIds: [...zone.eventIds],
        };
        zone.escalations.push(escalation);
        escalations.push({ zoneId: zone.zoneId, ...escalation });
        zone.recheckDueAt = new Date(ms(zone.recheckDueAt) + zone.recheckIntervalMinutes * 60000).toISOString();
      }
      this.store.put(zone.recordId, zone);
    }
    return { now, escalations };
  }

  /** 登记一次复查，并顺延下一次复查期限。 */
  recheckZone(zoneId, { by = null, note = null } = {}) {
    const zone = this.#zone(zoneId);
    if (zone.state !== "closed") throw new Error("区域未处于关闭状态");
    const now = this.clock.now();
    zone.rechecks.push({ by, note, at: now });
    zone.recheckDueAt = new Date(ms(now) + zone.recheckIntervalMinutes * 60000).toISOString();
    this.store.put(zone.recordId, zone);
    return structuredClone(zone);
  }

  // ---- 查询 ----

  /** 查看区域：状态、关闭或复开理由、尚待核查的就餐批次和当时适用的处置规则。 */
  viewZone(zoneId) {
    const zone = this.#zone(zoneId);
    const events = zone.eventIds.map((id) => this.store.get(`event:${id}`)).filter(Boolean);
    const pendingMealBatches = events.flatMap((e) =>
      e.mealBatches.filter((b) => b.status === "pending").map((b) => ({ eventId: e.eventId, batchId: b.batchId, sources: b.sources })),
    );
    const unresolvedConflicts = events.flatMap((e) =>
      e.conflicts.filter((c) => c.status === "unresolved").map((c) => ({ eventId: e.eventId, ...c })),
    );
    const plan = events.map((e) => this.#activePlan(e.eventId)).find(Boolean) ?? null;
    return {
      zoneId: zone.zoneId,
      siteId: zone.siteId,
      state: zone.state,
      reasons: zone.reasons,
      pendingMealBatches,
      unresolvedConflicts,
      appliedRule: plan?.ruleSnapshot ?? null,
      plan: plan
        ? { planId: plan.planId, eventId: plan.eventId, status: plan.status, steps: plan.steps, disinfection: plan.disinfection }
        : null,
      recheckDueAt: zone.recheckDueAt,
      rechecks: zone.rechecks,
      escalations: zone.escalations,
      reopenBlockers: zone.state === "closed" ? this.reopenBlockers(zoneId) : [],
    };
  }

  viewEvent(eventId) {
    return this.#event(eventId);
  }

  // ---- 内部 ----

  #nextId(prefix) {
    const next = (this.store.getMeta("seq") ?? 0) + 1;
    this.store.setMeta("seq", next);
    return `${prefix}-${next}`;
  }

  #addConflict(event, type, detail, batchId) {
    event.conflicts.push({
      conflictId: `${event.eventId}-c${event.conflicts.length + 1}`,
      type,
      detail,
      batchId,
      status: "unresolved",
      createdAt: this.clock.now(),
    });
  }

  #closeZone(event, now, rule) {
    const key = `zone:${event.zoneId}`;
    let zone = this.store.get(key);
    if (!zone) {
      zone = {
        recordId: key,
        zoneId: event.zoneId,
        siteId: event.siteId,
        state: "open",
        reasons: [],
        rechecks: [],
        inspections: [],
        escalations: [],
        eventIds: [],
        recheckIntervalMinutes: rule?.recheckIntervalMinutes ?? DEFAULT_RECHECK_INTERVAL_MINUTES,
        recheckDueAt: null,
      };
    }
    if (!zone.eventIds.includes(event.eventId)) zone.eventIds.push(event.eventId);
    if (zone.state !== "closed") {
      zone.state = "closed";
      zone.reasons.push({ type: "closed", reason: `聚集性胃肠事件 ${event.eventId} 处置中`, at: now });
      zone.recheckDueAt = new Date(ms(now) + zone.recheckIntervalMinutes * 60000).toISOString();
    }
    this.store.put(key, zone);
    return zone;
  }

  #event(eventId) {
    const event = this.store.get(`event:${eventId}`);
    if (!event) throw new Error("事件不存在");
    return event;
  }

  #zone(zoneId) {
    const zone = this.store.get(`zone:${zoneId}`);
    if (!zone) throw new Error("区域不存在");
    return zone;
  }

  #activePlan(eventId) {
    return (
      this.store
        .all()
        .filter(([key]) => key.startsWith("plan:"))
        .map(([, value]) => value)
        .find((p) => p.eventId === eventId && p.status === "active") ?? null
    );
  }
}
