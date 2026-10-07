/** 提供可替换的业务时钟。 */
export class Clock {
  now() {
    return new Date().toISOString();
  }
}

/**
 * 由值班人员推进的模拟时钟。
 * 计时依据（当前模拟时刻）持久化在存储中，重启服务后不会重置。
 */
export class ManualClock extends Clock {
  constructor(store, { startAt } = {}) {
    super();
    this.store = store;
    if (this.store.getMeta("sim_now_ms") == null) {
      this.store.setMeta("sim_now_ms", startAt != null ? Date.parse(startAt) : Date.now());
    }
  }

  now() {
    return new Date(this.store.getMeta("sim_now_ms")).toISOString();
  }

  /** 推进模拟时钟，返回推进后的时刻。 */
  advance(minutes) {
    const next = this.store.getMeta("sim_now_ms") + minutes * 60000;
    this.store.setMeta("sim_now_ms", next);
    return this.now();
  }
}
