import { canonicalize } from './canonical.mjs';
import { assertDate, DataError, opportunityKey, requireDate } from './opportunity.mjs';
function assertTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DataError('notice_invalid', `${field} 必须是 ISO 时间戳`);
  }
  return new Date(value).toISOString();
}

function normalizeEligibilityPatch(value, field) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new DataError('notice_invalid', `${field} 必须是维度到取值的对象`);
  }
  const patch = {};
  for (const [rawDimension, allowed] of Object.entries(value)) {
    const dimension = rawDimension.trim();
    if (!dimension) {
      throw new DataError('notice_invalid', `${field} 包含空维度名`);
    }
    if (allowed == null) {
      patch[dimension] = null;
    } else if (Array.isArray(allowed)) {
      const values = allowed.map((entry) => {
        if (typeof entry !== 'string' || !entry.trim()) {
          throw new DataError('notice_invalid', `${field}.${dimension} 含无效值`);
        }
        return entry.trim();
      });
      patch[dimension] = [...new Set(values)].sort();
    } else {
      throw new DataError('notice_invalid', `${field}.${dimension} 必须是数组或 null`);
    }
  }
  return Object.fromEntries(Object.keys(patch).sort().map((key) => [key, patch[key]]));
}

// 补充通知只描述“改了什么”，永远不改写原页面。它通过强引用落到一个项目上：
// source+id、唯一 id，或机构的 externalId。绝不按名称相似度猜测。
export function normalizeNotice(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new DataError('notice_invalid', '补充通知必须是对象');
  }
  if (typeof input.id !== 'string' || !input.id.trim()) {
    throw new DataError('notice_invalid', '补充通知缺少 id');
  }
  const id = input.id.trim();
  const revision = input.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) {
    throw new DataError('notice_invalid', `${id}.revision 必须是正整数`);
  }
  const issuedAt = assertTimestamp(input.issuedAt, `${id}.issuedAt`);
  const effectiveFrom =
    input.effectiveFrom == null
      ? issuedAt.slice(0, 10)
      : assertDate(input.effectiveFrom, `${id}.effectiveFrom`);

  if (
    !input.reference ||
    typeof input.reference !== 'object' ||
    Array.isArray(input.reference)
  ) {
    throw new DataError('notice_invalid', `${id} 缺少项目引用 reference`);
  }

  const raw = input.changes ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DataError('notice_invalid', `${id}.changes 必须是对象`);
  }
  const changes = {};
  if (Object.hasOwn(raw, 'deadline')) {
    changes.deadline =
      raw.deadline == null ? null : assertDate(raw.deadline, `${id}.changes.deadline`);
  }
  if (Object.hasOwn(raw, 'eligibility')) {
    const patch = normalizeEligibilityPatch(raw.eligibility, `${id}.changes.eligibility`);
    // 空补丁没有改变任何维度，不能伪装成一条有效通知。
    if (Object.keys(patch).length) changes.eligibility = patch;
  }
  if (Object.keys(changes).length === 0) {
    throw new DataError('notice_invalid', `${id} 没有可应用的变更`);
  }

  if (
    input.supersedes != null &&
    (typeof input.supersedes !== 'string' || !input.supersedes.trim())
  ) {
    throw new DataError('notice_invalid', `${id}.supersedes 必须是通知 id`);
  }

  return {
    id,
    revision,
    issuedAt,
    effectiveFrom,
    reference: { ...input.reference },
    changes,
    supersedes: input.supersedes?.trim() ?? null,
    note: input.note == null ? null : String(input.note),
  };
}

function compareNotices(left, right) {
  return (
    left.effectiveFrom.localeCompare(right.effectiveFrom) ||
    left.issuedAt.localeCompare(right.issuedAt) ||
    left.revision - right.revision ||
    left.id.localeCompare(right.id)
  );
}

export class NoticeLog {
  #notices = new Map();
  #targets = new Map();

  add(input) {
    const notice = normalizeNotice(input);
    const previous = this.#notices.get(notice.id);
    if (previous) {
      if (notice.revision < previous.revision) return this;
      if (notice.revision === previous.revision) {
        if (canonicalize(previous) !== canonicalize(notice)) {
          throw new DataError('notice_conflict', `通知 ${notice.id} 同一修订号内容不同`);
        }
        return this;
      }
    }
    this.#notices.set(notice.id, notice);
    return this;
  }

  // 通知投递：在接收时就把通知绑到一个明确的目录项目上。无法唯一对应时
  // 直接报错，绝不把通知挂到“最像”的另一个项目。同一条通知不得在不同
  // 修订之间改投别的项目，否则历史解释会出现同一通知影响两个项目的歧义。
  attach(catalog, input) {
    const incoming = normalizeNotice(input);
    const existing = this.#notices.get(incoming.id);
    // 迟到的低修订号版本不会取代已保存版本，也不需要重新解析目标。
    if (existing && existing.revision > incoming.revision) {
      const bound = this.#targets.get(incoming.id);
      return {
        notice: structuredClone(existing),
        target: bound ? structuredClone(catalog.resolve(bound.reference)) : null,
      };
    }
    const target = catalog.resolve(incoming.reference);
    const key = opportunityKey(target);
    const previousTarget = this.#targets.get(incoming.id);
    if (previousTarget && previousTarget.key !== key) {
      throw new DataError(
        'notice_conflict',
        `通知 ${incoming.id} 已投向 ${previousTarget.key}，不能改投 ${key}`,
      );
    }
    this.add(incoming);
    const stored = this.#notices.get(incoming.id);
    this.#targets.set(incoming.id, {
      key,
      baseRevision: target.revision,
      source: target.source,
      id: target.id,
      reference: structuredClone(stored.reference),
    });
    return { notice: structuredClone(stored), target: structuredClone(target) };
  }

  get(id) {
    const notice = this.#notices.get(id);
    return notice ? structuredClone(notice) : null;
  }

  targetOf(id) {
    const target = this.#targets.get(id);
    return target ? structuredClone(target) : null;
  }

  all() {
    return [...this.#notices.values()]
      .sort(compareNotices)
      .map((notice) => structuredClone(notice));
  }

  #validateSupersedeChain() {
    for (const notice of this.#notices.values()) {
      if (!notice.supersedes) continue;
      if (!this.#notices.has(notice.supersedes)) {
        throw new DataError(
          'notice_supersede_missing',
          `通知 ${notice.id} 取代了不存在的通知 ${notice.supersedes}`,
        );
      }
    }
    for (const start of this.#notices.keys()) {
      const seen = new Set();
      let current = start;
      while (current) {
        if (seen.has(current)) {
          throw new DataError('notice_supersede_cycle', '补充通知的取代关系出现环');
        }
        seen.add(current);
        current = this.#notices.get(current)?.supersedes;
      }
    }
  }

  // 某个日期上仍然有效的通知。取代只在取代者自己也生效后才发生：
  // 历史日期仍按当时有效的旧通知计算。
  effectiveOn(asOf) {
    requireDate(asOf, 'asOf');
    this.#validateSupersedeChain();
    const applicable = [...this.#notices.values()].filter(
      (notice) => notice.effectiveFrom <= asOf,
    );
    const superseded = new Set();
    for (const notice of applicable) {
      if (notice.supersedes) superseded.add(notice.supersedes);
    }
    return applicable
      .filter((notice) => !superseded.has(notice.id))
      .sort(compareNotices)
      .map((notice) => structuredClone(notice));
  }

  // 对某项目、某日期生效的通知子集。通知只作用于接收时绑定（或按强引用
  // 唯一解析出）的那个项目。
  effectiveFor(catalog, key, asOf) {
    return this.effectiveOn(asOf).filter((notice) => {
      const bound = this.#targets.get(notice.id);
      if (bound) return bound.key === key;
      const target = catalog.resolve(notice.reference);
      return opportunityKey(target) === key;
    });
  }
}

// 计算项目在给定日期上的有效条件；原页面保持原样，不被通知改写。
export function conditionsAt(catalog, log, key, asOf) {
  const opportunity = catalog.byKey(key);
  if (!opportunity) {
    throw new DataError('opportunity_missing', `目录中没有项目 ${key}`);
  }
  const notices = log.effectiveFor(catalog, key, asOf);
  const conditions = {
    deadline: opportunity.baseConditions.deadline,
    eligibility: structuredClone(opportunity.baseConditions.eligibility),
  };
  for (const notice of notices) {
    if (Object.hasOwn(notice.changes, 'deadline')) {
      conditions.deadline = notice.changes.deadline;
    }
    for (const [dimension, allowed] of Object.entries(notice.changes.eligibility ?? {})) {
      if (allowed == null) {
        delete conditions.eligibility[dimension];
      } else {
        conditions.eligibility[dimension] = [...allowed];
      }
    }
  }
  return {
    key,
    asOf,
    baseRevision: opportunity.revision,
    deadline: conditions.deadline,
    eligibility: Object.fromEntries(
      Object.keys(conditions.eligibility)
        .sort()
        .map((dimension) => [dimension, conditions.eligibility[dimension]]),
    ),
    appliedNotices: notices.map((notice) => notice.id),
  };
}
