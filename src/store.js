/** 保存基础登记记录。 */
export class Store {
  constructor() {
    this.records = new Map();
    this.meta = new Map();
  }

  add(record) {
    if (this.records.has(record.recordId)) {
      throw new Error("记录编号已存在");
    }
    this.records.set(record.recordId, structuredClone(record));
  }

  /** 以键覆盖写入记录。 */
  put(key, value) {
    this.records.set(key, structuredClone(value));
  }

  get(recordId) {
    const value = this.records.get(recordId);
    return value ? structuredClone(value) : null;
  }

  /** 返回全部 [键, 记录] 条目。 */
  all() {
    return [...this.records.entries()].map(([key, value]) => [key, structuredClone(value)]);
  }

  getMeta(key) {
    return this.meta.get(key);
  }

  setMeta(key, value) {
    this.meta.set(key, value);
  }
}
