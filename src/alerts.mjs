import { canonicalize, hashValue } from './canonical.mjs';
import { normalizeCriteria, matchesCriteria } from './screening.mjs';
import { conditionsAt } from './notices.mjs';
import { DataError, requireDate } from './opportunity.mjs';

function assertTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DataError('alert_invalid', `${field} 必须是 ISO 时间戳`);
  }
  return new Date(value).toISOString();
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

// 从目录与通知日志现场生成提醒所需的条件快照，避免调用方手抄一份已经
// 过期的规则。必须提供保存的筛选结果（或明确的 criteria）；否则“符合条件”
// 无从验证，不能发出提醒。
export function prepareAlert({ screen = null, criteria: explicit, result, asOf, catalog, notices }) {
  if (!catalog || !notices) {
    throw new DataError('alert_invalid', '生成提醒需要目录与通知记录');
  }
  if (!result || typeof result !== 'object' || !result.key) {
    throw new DataError('alert_invalid', '生成提醒需要筛选结果条目');
  }
  const rawCriteria = screen?.criteria ?? explicit;
  if (rawCriteria == null) {
    throw new DataError('alert_invalid', '生成提醒需要保存的筛选条件');
  }
  const criteria = normalizeCriteria(rawCriteria);
  const opportunity = catalog.byKey(result.key);
  if (!opportunity) {
    throw new DataError('alert_invalid', `目录中没有项目 ${result.key}`);
  }
  const conditions = conditionsAt(catalog, notices, result.key, asOf);
  if (!matchesCriteria(opportunity, conditions, criteria)) {
    throw new DataError(
      'alert_not_matching',
      `项目 ${result.key} 在 ${asOf} 不满足该筛选条件，不能据此发出提醒`,
    );
  }
  const applied = new Set(conditions.appliedNotices);
  const appliedNotices = notices
    .all()
    .filter((notice) => applied.has(notice.id));
  return {
    screenId: screen?.id ?? null,
    opportunity: {
      key: result.key,
      source: opportunity.source,
      id: opportunity.id,
      name: opportunity.name,
      state: opportunity.state,
      agency: opportunity.agency,
    },
    criteria,
    conditions,
    notices: appliedNotices,
  };
}

// 提醒一旦发出就冻结“当时使用的规则”：筛选条件、当日有效条件、所依据的
// 通知及其修订号，全部按值保存。之后即便原页面更新、通知被取代或修正，
// 已发提醒仍能解释当时为什么推荐该项目。
export class AlertLog {
  #alerts = new Map();

  send({ id, screenId, recipient, opportunity, criteria, conditions, notices, sentAt, note = null }) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new DataError('alert_invalid', '提醒缺少 id');
    }
    const alertId = id.trim();
    if (this.#alerts.has(alertId)) {
      throw new DataError('alert_conflict', `提醒 ${alertId} 已存在`);
    }
    if (typeof recipient !== 'string' || !recipient.trim()) {
      throw new DataError('alert_invalid', `${alertId} 缺少收件人`);
    }
    if (!opportunity || !opportunity.key) {
      throw new DataError('alert_invalid', `${alertId} 缺少机会引用`);
    }
    if (!conditions || typeof conditions !== 'object') {
      throw new DataError('alert_invalid', `${alertId} 缺少发送时的条件快照`);
    }
    requireDate(conditions.asOf, `${alertId}.conditions.asOf`);
    const normalizedCriteria = normalizeCriteria(criteria);
    const appliedNotices = [...(conditions.appliedNotices ?? [])].sort();
    const frozenNotices = (notices ?? []).map((notice) => ({
      id: notice.id,
      revision: notice.revision,
      issuedAt: notice.issuedAt,
      effectiveFrom: notice.effectiveFrom,
      changes: clone(notice.changes),
    }));

    // 声称“依据这些通知”就必须完整提供它们的快照，反之亦然。
    const provided = frozenNotices.map((notice) => notice.id).sort();
    if (canonicalize(provided) !== canonicalize(appliedNotices)) {
      throw new DataError(
        'alert_invalid',
        `${alertId} 的通知快照与条件使用的通知列表不一致`,
        { expected: appliedNotices, provided },
      );
    }

    const rule = {
      criteria: normalizedCriteria,
      criteriaHash: hashValue(normalizedCriteria),
      conditions: {
        asOf: conditions.asOf,
        baseRevision: conditions.baseRevision ?? null,
        deadline: conditions.deadline ?? null,
        eligibility: clone(conditions.eligibility ?? {}),
        appliedNotices,
      },
      notices: frozenNotices,
    };
    rule.ruleHash = hashValue(rule);

    const alert = {
      id: alertId,
      screenId: screenId == null ? null : String(screenId),
      recipient: recipient.trim(),
      sentAt: assertTimestamp(sentAt, `${alertId}.sentAt`),
      opportunity: clone(opportunity),
      rule,
      note: note == null ? null : String(note),
    };
    this.#alerts.set(alertId, alert);
    return clone(alert);
  }

  get(id) {
    const alert = this.#alerts.get(id);
    return alert ? clone(alert) : null;
  }

  list({ screenId, recipient } = {}) {
    return [...this.#alerts.values()]
      .filter((alert) => screenId == null || alert.screenId === screenId)
      .filter((alert) => recipient == null || alert.recipient === recipient)
      .sort(
        (left, right) =>
          left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id),
      )
      .map((alert) => clone(alert));
  }

  // 解释某条提醒：给出当时冻结的规则与逐项依据。
  // 不重新计算——重新计算会用到今天的通知，反而掩盖当时的判断依据。
  explain(id) {
    const alert = this.get(id);
    if (!alert) {
      throw new DataError('alert_missing', `没有提醒 ${id}`);
    }
    const reasons = [];
    const { conditions, criteria } = alert.rule;
    if (criteria.deadlineOnOrAfter || criteria.deadlineOnOrBefore) {
      reasons.push({
        type: 'deadline',
        value: conditions.deadline,
        matchedBecause:
          conditions.deadline == null
            ? '项目没有固定截止日期，按长期开放处理'
            : '截止日期落在筛选范围内',
      });
    }
    for (const [dimension, desired] of Object.entries(criteria.eligibility ?? {})) {
      const allowed = conditions.eligibility[dimension];
      reasons.push({
        type: 'eligibility',
        dimension,
        requested: [...desired],
        allowed: allowed == null ? null : [...allowed],
        matchedBecause:
          allowed == null ? '项目未限制该维度' : '申请人的取值与项目允许值有交集',
      });
    }
    if (criteria.states) {
      reasons.push({
        type: 'state',
        requested: [...criteria.states],
        value: alert.opportunity.state ?? null,
        matchedBecause: '项目状态在筛选范围内',
      });
    }
    return {
      alertId: alert.id,
      sentAt: alert.sentAt,
      opportunity: clone(alert.opportunity),
      rule: clone(alert.rule),
      reasons,
      noticesAtSend: clone(alert.rule.notices),
    };
  }
}

// 对比“当时规则”与“今天规则”，用于向学者说明推荐为何会/不会变化。
// 这里显式重算，但只作为补充信息，不覆盖提醒自身保存的依据。
export function compareWithCurrent(alert, conditionsNow) {
  const before = alert.rule.conditions;
  const after = {
    deadline: conditionsNow.deadline ?? null,
    eligibility: clone(conditionsNow.eligibility ?? {}),
    appliedNotices: [...(conditionsNow.appliedNotices ?? [])].sort(),
  };
  return {
    alertId: alert.id,
    ruleUnchanged:
      canonicalize({
        deadline: before.deadline,
        eligibility: before.eligibility,
        appliedNotices: before.appliedNotices,
      }) === canonicalize(after),
    deadline: { then: before.deadline, now: after.deadline },
    eligibility: { then: clone(before.eligibility), now: clone(after.eligibility) },
    notices: { then: [...before.appliedNotices], now: after.appliedNotices },
  };
}
