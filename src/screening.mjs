import { canonicalize, hashValue } from './canonical.mjs';
import { conditionsAt } from './notices.mjs';
import { assertDate, DataError, opportunityKey, requireDate } from './opportunity.mjs';

function normalizeValueList(value, field) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    throw new DataError('criteria_invalid', `${field} 必须是字符串数组或 null`);
  }
  if (value.length === 0) {
    throw new DataError('criteria_invalid', `${field} 不能是空数组`);
  }
  const values = value.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new DataError('criteria_invalid', `${field} 包含无效值`);
    }
    return entry.trim();
  });
  return [...new Set(values)].sort();
}

export function normalizeCriteria(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DataError('criteria_invalid', '筛选条件必须是对象');
  }
  const criteria = {
    deadlineOnOrAfter: assertDate(input.deadlineOnOrAfter ?? null, 'deadlineOnOrAfter'),
    deadlineOnOrBefore: assertDate(input.deadlineOnOrBefore ?? null, 'deadlineOnOrBefore'),
    states: normalizeValueList(input.states, 'states')?.sort() ?? null,
    eligibility: null,
  };
  if (
    criteria.deadlineOnOrAfter &&
    criteria.deadlineOnOrBefore &&
    criteria.deadlineOnOrAfter > criteria.deadlineOnOrBefore
  ) {
    throw new DataError('criteria_invalid', '截止日期下限晚于上限');
  }
  if (input.eligibility != null) {
    if (typeof input.eligibility !== 'object' || Array.isArray(input.eligibility)) {
      throw new DataError('criteria_invalid', 'eligibility 必须是维度到取值数组的对象');
    }
    const eligibility = {};
    for (const [rawDimension, values] of Object.entries(input.eligibility)) {
      const dimension = rawDimension.trim();
      if (!dimension) {
        throw new DataError('criteria_invalid', 'eligibility 包含空维度名');
      }
      const normalized = normalizeValueList(values, `eligibility.${dimension}`);
      if (normalized != null) eligibility[dimension] = normalized;
    }
    criteria.eligibility = Object.fromEntries(
      Object.keys(eligibility)
        .sort()
        .map((key) => [key, eligibility[key]]),
    );
  }
  return criteria;
}

// 资格维度取“申请人可选值”与“项目允许值”的交集；项目不限该维度时视为符合。
export function matchesCriteria(opportunity, conditions, criteria) {
  if (criteria.states && !criteria.states.includes(opportunity.state)) {
    return false;
  }
  // 没有固定截止日期的项目视为长期开放，不因日期筛选被排除。
  if (conditions.deadline != null) {
    if (criteria.deadlineOnOrAfter && conditions.deadline < criteria.deadlineOnOrAfter) {
      return false;
    }
    if (criteria.deadlineOnOrBefore && conditions.deadline > criteria.deadlineOnOrBefore) {
      return false;
    }
  }
  for (const [dimension, desired] of Object.entries(criteria.eligibility ?? {})) {
    const allowed = conditions.eligibility[dimension];
    if (allowed == null) continue;
    if (!desired.some((value) => allowed.includes(value))) return false;
  }
  return true;
}

function resultEntry(opportunity, conditions) {
  return {
    key: opportunityKey(opportunity),
    source: opportunity.source,
    id: opportunity.id,
    name: opportunity.name,
    state: opportunity.state,
    deadline: conditions.deadline,
    eligibility: structuredClone(conditions.eligibility),
    appliedNotices: [...conditions.appliedNotices],
  };
}

export function evaluateCriteria(catalog, log, criteria, asOf) {
  const normalized = normalizeCriteria(criteria);
  requireDate(asOf, 'asOf');
  const results = [];
  for (const opportunity of catalog.opportunities) {
    const conditions = conditionsAt(catalog, log, opportunityKey(opportunity), asOf);
    if (matchesCriteria(opportunity, conditions, normalized)) {
      results.push(resultEntry(opportunity, conditions));
    }
  }
  results.sort((left, right) => left.key.localeCompare(right.key));
  return {
    asOf,
    criteria: normalized,
    criteriaHash: hashValue(normalized),
    results,
    resultHash: hashValue(results.map((entry) => entry.key)),
  };
}

export function diffResults(previous, current) {
  const before = new Map(previous.results.map((entry) => [entry.key, entry]));
  const after = new Map(current.results.map((entry) => [entry.key, entry]));
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed = [];
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old) continue;
    const changes = [];
    for (const field of ['name', 'state', 'deadline', 'eligibility', 'appliedNotices']) {
      if (canonicalize(old[field]) !== canonicalize(entry[field])) {
        changes.push({ field, before: old[field], after: entry[field] });
      }
    }
    if (changes.length) changed.push({ key, changes });
  }
  return { added, removed, changed };
}

// 保存的筛选结果只保存条件与每次求值的结果。重算时重新走“当前目录 +
// 当前有效通知”，不缓存上一次判定；历史仍保留，便于解释变化来源。
export class ScreenStore {
  #screens = new Map();

  static #evaluate({ criteria, asOf, catalog, notices }) {
    if (!catalog) throw new DataError('screen_invalid', '缺少机会目录');
    if (!notices) throw new DataError('screen_invalid', '缺少补充通知记录');
    const evaluation = evaluateCriteria(catalog, notices, criteria, asOf);
    return {
      asOf: evaluation.asOf,
      criteriaHash: evaluation.criteriaHash,
      resultHash: evaluation.resultHash,
      results: evaluation.results,
    };
  }

  static #assertId(id) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new DataError('screen_invalid', '筛选结果缺少 id');
    }
    return id.trim();
  }

  save({ id, name, criteria, asOf, catalog, notices, now = new Date().toISOString() }) {
    const screenId = ScreenStore.#assertId(id);
    if (this.#screens.has(screenId)) {
      throw new DataError('screen_conflict', `筛选结果 ${screenId} 已存在`);
    }
    const normalized = normalizeCriteria(criteria);
    const evaluation = ScreenStore.#evaluate({ criteria: normalized, asOf, catalog, notices });
    const screen = {
      id: screenId,
      name: name == null ? screenId : String(name),
      criteria: normalized,
      criteriaRevision: 1,
      createdAt: now,
      updatedAt: now,
      current: evaluation,
      history: [structuredClone(evaluation)],
    };
    this.#screens.set(screenId, screen);
    return structuredClone(screen);
  }

  get(id) {
    const screen = this.#screens.get(id);
    return screen ? structuredClone(screen) : null;
  }

  list() {
    return [...this.#screens.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((screen) => structuredClone(screen));
  }

  updateCriteria(id, criteria, { asOf, catalog, notices, now = new Date().toISOString() }) {
    const screen = this.#require(id);
    const normalized = normalizeCriteria(criteria);
    if (canonicalize(normalized) === canonicalize(screen.criteria)) {
      throw new DataError('screen_unchanged', `筛选结果 ${id} 的条件没有变化`);
    }
    const previous = structuredClone(screen.current);
    screen.criteria = normalized;
    screen.criteriaRevision += 1;
    screen.updatedAt = now;
    const current = ScreenStore.#evaluate({ criteria: normalized, asOf, catalog, notices });
    screen.current = current;
    screen.history.push(structuredClone(current));
    return {
      screenId: id,
      criteriaRevision: screen.criteriaRevision,
      from: previous,
      to: current,
      ...diffResults(previous, current),
    };
  }

  reevaluate(id, { asOf, catalog, notices, now = new Date().toISOString() }) {
    const screen = this.#require(id);
    const previous = structuredClone(screen.current);
    const current = ScreenStore.#evaluate({
      criteria: screen.criteria,
      asOf,
      catalog,
      notices,
    });
    screen.current = current;
    screen.updatedAt = now;
    screen.history.push(structuredClone(current));
    return {
      screenId: id,
      criteriaRevision: screen.criteriaRevision,
      from: previous,
      to: current,
      ...diffResults(previous, current),
    };
  }

  #require(id) {
    const screenId = ScreenStore.#assertId(id);
    const screen = this.#screens.get(screenId);
    if (!screen) {
      throw new DataError('screen_missing', `没有筛选结果 ${screenId}`);
    }
    return screen;
  }
}
