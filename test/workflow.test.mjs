import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../src/catalog.mjs';
import { NoticeLog, conditionsAt } from '../src/notices.mjs';
import { ScreenStore } from '../src/screening.mjs';
import { AlertLog, compareWithCurrent, prepareAlert } from '../src/alerts.mjs';
import { loadCatalog } from '../src/pipeline.mjs';

const page = {
  source: 'local',
  observedAt: '2026-11-17T08:00:00.000Z',
  items: [
    {
      id: 'a',
      label: '甲项目',
      state: 'active',
      revision: 1,
      agency: '基金会甲',
      externalIds: { 基金会甲: 'A-001' },
      deadline: '2027-01-15',
      eligibility: { careerStage: ['early'], discipline: ['化学'] },
    },
    {
      id: 'b',
      label: '乙项目',
      state: 'active',
      revision: 1,
      agency: '基金会甲',
      externalIds: { 基金会甲: 'B-001' },
      deadline: '2027-02-28',
      eligibility: { careerStage: ['early', 'mid'], discipline: null },
    },
  ],
};

function setup() {
  const catalog = new Catalog().ingest(page);
  const notices = new NoticeLog();
  return { catalog, notices };
}

function notice(overrides = {}) {
  return {
    id: 'N-1',
    revision: 1,
    issuedAt: '2026-11-17T12:00:00.000Z',
    effectiveFrom: '2026-11-18',
    reference: { source: 'local', id: 'a' },
    changes: { deadline: '2026-12-15' },
    ...overrides,
  };
}

test('补充通知绑定到正确项目', () => {
  const { catalog, notices } = setup();
  const { target } = notices.attach(catalog, notice());
  assert.equal(`${target.source}:${target.id}`, 'local:a');
  assert.equal(notices.targetOf('N-1').key, 'local:a');
  assert.equal(
    conditionsAt(catalog, notices, 'local:b', '2026-12-01').deadline,
    '2027-02-28',
  );
});

test('外部编号可解析通知目标；未知或歧义引用被拒绝', () => {
  const { catalog, notices } = setup();
  const resolved = notices.attach(
    catalog,
    notice({ reference: { agency: '基金会甲', externalId: 'B-001' } }),
  );
  assert.equal(resolved.target.id, 'b');

  assert.throws(
    () => notices.attach(catalog, notice({ id: 'N-x', reference: { externalId: 'NOPE' } })),
    (error) => error.code === 'notice_reference_invalid',
  );
  assert.throws(
    () => notices.attach(catalog, notice({ id: 'N-y', reference: { agency: '基金会甲', externalId: 'NOPE' } })),
    (error) => error.code === 'notice_unmatched',
  );

  const ambiguous = new Catalog().ingest({
    source: 'one',
    items: [page.items[1]],
  });
  ambiguous.ingest({ source: 'two', items: [page.items[1]] });
  assert.throws(
    () => new NoticeLog().attach(ambiguous, notice({ reference: { id: 'b' } })),
    (error) => error.code === 'notice_ambiguous',
  );
});

test('名称相似不会被当成匹配依据', () => {
  const { catalog, notices } = setup();
  assert.throws(
    () => notices.attach(catalog, notice({ reference: { name: '甲项目' } })),
    (error) => error.code === 'notice_reference_invalid',
  );
});

test('通知不修改原页面；只在生效日期后生效', () => {
  const { catalog, notices } = setup();
  notices.attach(
    catalog,
    notice({
      changes: {
        deadline: '2026-12-15',
        eligibility: { careerStage: ['early', 'mid'] },
      },
    }),
  );

  assert.equal(catalog.byKey('local:a').baseConditions.deadline, '2027-01-15');
  assert.deepEqual(catalog.byKey('local:a').baseConditions.eligibility.careerStage, ['early']);

  const before = conditionsAt(catalog, notices, 'local:a', '2026-11-17');
  assert.equal(before.deadline, '2027-01-15');
  assert.deepEqual(before.eligibility.careerStage, ['early']);
  assert.deepEqual(before.appliedNotices, []);

  const after = conditionsAt(catalog, notices, 'local:a', '2026-11-18');
  assert.equal(after.deadline, '2026-12-15');
  assert.deepEqual(after.eligibility.careerStage, ['early', 'mid']);
  assert.deepEqual(after.appliedNotices, ['N-1']);
});

test('无效日期与空变更被拒绝', () => {
  const { catalog, notices } = setup();
  assert.throws(() => notices.attach(catalog, notice({ changes: {} })), /没有可应用的变更/);
  assert.throws(() => notices.attach(catalog, notice({ changes: { deadline: '2026-02-30' } })), /日期/);
  assert.throws(
    () => notices.attach(catalog, notice({ changes: { extra: 1 } })),
    /没有可应用的变更/,
  );
});

test('同一通知修订号内容冲突被拒绝，较新修订覆盖', () => {
  const { catalog, notices } = setup();
  notices.attach(catalog, notice());
  assert.throws(
    () => notices.attach(catalog, notice({ changes: { deadline: '2026-12-20' } })),
    (error) => error.code === 'notice_conflict',
  );
  notices.attach(catalog, notice({ revision: 2, changes: { deadline: '2026-12-20' } }));
  assert.equal(conditionsAt(catalog, notices, 'local:a', '2026-11-20').deadline, '2026-12-20');
});

test('后续通知可取代旧通知，且历史日期仍使用旧规则', () => {
  const { catalog, notices } = setup();
  notices.attach(catalog, notice());
  notices.attach(
    catalog,
    notice({
      id: 'N-2',
      effectiveFrom: '2026-11-25',
      supersedes: 'N-1',
      changes: { deadline: '2027-03-01' },
    }),
  );
  assert.equal(conditionsAt(catalog, notices, 'local:a', '2026-11-20').deadline, '2026-12-15');
  assert.equal(conditionsAt(catalog, notices, 'local:a', '2026-11-25').deadline, '2027-03-01');
  assert.deepEqual(
    conditionsAt(catalog, notices, 'local:a', '2026-11-25').appliedNotices,
    ['N-2'],
  );
});

test('保存的筛选结果按新条件重新判断', () => {
  const { catalog, notices } = setup();
  const screens = new ScreenStore();
  const criteria = {
    states: ['active'],
    deadlineOnOrAfter: '2026-11-01',
    eligibility: { careerStage: ['mid'] },
  };
  const saved = screens.save({
    id: 'S-1',
    name: '中期学者机会',
    criteria,
    asOf: '2026-11-17',
    catalog,
    notices,
  });
  // 通知生效前，甲项目只面向 early，与 mid 不符。
  assert.deepEqual(saved.current.results.map((entry) => entry.id), ['b']);

  // 补充通知放宽 careerStage 并提前截止日期：甲项目应被重新判断后入选。
  notices.attach(
    catalog,
    notice({
      changes: {
        deadline: '2026-12-15',
        eligibility: { careerStage: ['early', 'mid'], discipline: ['化学', '生物'] },
      },
    }),
  );
  screens.save({
    id: 'S-2',
    criteria: { states: ['active'], deadlineOnOrAfter: '2027-01-01' },
    asOf: '2026-11-17',
    catalog,
    notices,
  });
  assert.deepEqual(
    screens.reevaluate('S-2', { asOf: '2026-11-18', catalog, notices }).removed,
    ['local:a'],
  );

  const revisited = screens.reevaluate('S-1', { asOf: '2026-11-18', catalog, notices });
  assert.deepEqual(revisited.to.results.map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(revisited.added, ['local:a']);
  assert.deepEqual(revisited.removed, []);
  assert.equal(revisited.to.results[0].deadline, '2026-12-15');
  assert.deepEqual(revisited.to.results[0].eligibility.discipline, ['化学', '生物']);

  // 同一批通知对已经入选的项目表现为“条件变化”，而不是新增或移除。
  screens.save({
    id: 'S-3',
    criteria: { states: ['active'] },
    asOf: '2026-11-17',
    catalog,
    notices,
  });
  const changed = screens.reevaluate('S-3', { asOf: '2026-11-18', catalog, notices });
  assert.deepEqual(changed.added, []);
  assert.deepEqual(changed.removed, []);
  assert.deepEqual(changed.changed.map((entry) => entry.key), ['local:a']);
  assert.deepEqual(
    changed.changed[0].changes.find((entry) => entry.field === 'deadline').after,
    '2026-12-15',
  );
  // 保存的筛选条件本身不被通知改写。
  assert.deepEqual(screens.get('S-1').criteria, {
    deadlineOnOrAfter: '2026-11-01',
    deadlineOnOrBefore: null,
    states: ['active'],
    eligibility: { careerStage: ['mid'] },
  });
});

test('筛选结果能区分“条件变化”与“重新求值”', () => {
  const { catalog, notices } = setup();
  const screens = new ScreenStore();
  screens.save({
    id: 'S-1',
    criteria: { states: ['active'] },
    asOf: '2026-11-17',
    catalog,
    notices,
  });
  assert.throws(
    () => screens.updateCriteria('S-1', { states: ['active'] }, {
      asOf: '2026-11-17',
      catalog,
      notices,
    }),
    (error) => error.code === 'screen_unchanged',
  );
  const updated = screens.updateCriteria(
    'S-1',
    { states: ['pending'] },
    { asOf: '2026-11-17', catalog, notices },
  );
  assert.equal(updated.criteriaRevision, 2);
  assert.deepEqual(updated.to.results, []);
  assert.deepEqual(updated.removed, ['local:a', 'local:b']);
  assert.equal(screens.get('S-1').history.length, 2);
});

test('已发提醒保留发送时的规则，不受后续修正影响', () => {
  const { catalog, notices } = setup();
  notices.attach(
    catalog,
    notice({ changes: { deadline: '2026-12-15', eligibility: { careerStage: ['early', 'mid'] } } }),
  );
  const screens = new ScreenStore();
  const criteria = {
    states: ['active'],
    deadlineOnOrBefore: '2026-12-31',
    eligibility: { careerStage: ['mid'] },
  };
  const screen = screens.save({
    id: 'S-1',
    criteria,
    asOf: '2026-11-18',
    catalog,
    notices,
  });
  const result = screen.current.results.find((entry) => entry.id === 'a');
  assert.ok(result, '甲项目在放宽后应被选中');

  const alerts = new AlertLog();
  const alert = alerts.send({
    id: 'AL-1',
    screenId: 'S-1',
    recipient: '学者甲',
    opportunity: {
      key: result.key,
      source: result.source,
      id: result.id,
      name: result.name,
      state: result.state,
    },
    criteria,
    conditions: {
      asOf: screen.current.asOf,
      baseRevision: catalog.byKey(result.key).revision,
      deadline: result.deadline,
      eligibility: result.eligibility,
      appliedNotices: result.appliedNotices,
    },
    notices: [notices.get('N-1')],
    sentAt: '2026-11-18T09:00:00.000Z',
  });

  // 之后通知被修正：新的资格不再包含 mid，若按今天规则不该推荐。
  notices.attach(
    catalog,
    notice({
      revision: 2,
      changes: { deadline: '2026-12-15', eligibility: { careerStage: ['early'] } },
    }),
  );
  const today = conditionsAt(catalog, notices, 'local:a', '2026-11-18');
  assert.deepEqual(today.eligibility.careerStage, ['early']);
  assert.deepEqual(screens.reevaluate('S-1', { asOf: '2026-11-18', catalog, notices }).removed, [
    'local:a',
  ]);

  const explanation = alerts.explain('AL-1');
  assert.deepEqual(explanation.rule.conditions.eligibility.careerStage, ['early', 'mid']);
  assert.equal(explanation.rule.conditions.deadline, '2026-12-15');
  assert.deepEqual(explanation.noticesAtSend.map((entry) => entry.id), ['N-1']);
  assert.equal(explanation.noticesAtSend[0].changes.eligibility.careerStage.join(','), 'early,mid');
  assert.equal(
    explanation.rule.criteriaHash,
    alert.rule.criteriaHash,
    '解释必须引用提醒自身冻结的规则',
  );

  const comparison = compareWithCurrent(alert, today);
  assert.equal(comparison.ruleUnchanged, false);
  assert.deepEqual(comparison.eligibility.then.careerStage, ['early', 'mid']);
  assert.deepEqual(comparison.eligibility.now.careerStage, ['early']);
});

test('prepareAlert 现场生成快照；不满足条件时拒绝提醒', () => {
  const { catalog, notices } = setup();
  notices.attach(
    catalog,
    notice({
      changes: {
        deadline: '2026-12-15',
        eligibility: { careerStage: ['early', 'mid'] },
      },
    }),
  );
  const screens = new ScreenStore();
  const criteria = {
    states: ['active'],
    deadlineOnOrBefore: '2026-12-31',
    eligibility: { careerStage: ['mid'] },
  };
  // 11-17 时甲项目只面向 early，任何 mid 学者都不该收到提醒。
  assert.throws(
    () =>
      prepareAlert({
        result: { key: 'local:a' },
        criteria,
        asOf: '2026-11-17',
        catalog,
        notices,
      }),
    (error) => error.code === 'alert_not_matching',
  );

  const screen = screens.save({
    id: 'S-1',
    criteria,
    asOf: '2026-11-18',
    catalog,
    notices,
  });
  const prepared = prepareAlert({
    screen,
    result: screen.current.results.find((entry) => entry.id === 'a'),
    asOf: '2026-11-18',
    catalog,
    notices,
  });
  assert.deepEqual(prepared.conditions.appliedNotices, ['N-1']);
  assert.deepEqual(prepared.notices.map((entry) => entry.id), ['N-1']);

  const alerts = new AlertLog();
  const alert = alerts.send({
    id: 'AL-1',
    recipient: '学者甲',
    sentAt: '2026-11-18T09:00:00.000Z',
    ...prepared,
  });
  assert.equal(alert.screenId, 'S-1');

  // 快照与通知列表不一致的提醒会被拒绝，避免解释时缺一份依据。
  assert.throws(
    () =>
      alerts.send({
        id: 'AL-2',
        recipient: '学者甲',
        sentAt: '2026-11-18T09:00:00.000Z',
        ...prepared,
        notices: [],
      }),
    (error) => error.code === 'alert_invalid',
  );
});

test('仓库自带数据可走通整条链路，且原页面保持原样', async () => {
  const { catalog, notices } = await loadCatalog();
  const target = catalog.byKey('sample-14:14-A');
  assert.equal(target.baseConditions.deadline, '2027-01-15');
  assert.deepEqual(notices.all().map((entry) => entry.id), ['SUP-2026-01', 'SUP-2026-02']);

  const effective = conditionsAt(catalog, notices, 'sample-14:14-A', '2026-11-18');
  assert.equal(effective.deadline, '2026-12-15');
  assert.deepEqual(effective.appliedNotices, ['SUP-2026-01']);

  // 14-B 的通知按 source+id 绑定；14-C 未收到任何通知。
  assert.deepEqual(
    conditionsAt(catalog, notices, 'sample-14:14-B', '2026-11-18').eligibility.discipline,
    ['医学', '生物'],
  );
  assert.deepEqual(
    conditionsAt(catalog, notices, 'sample-14:14-C', '2026-11-18'),
    {
      key: 'sample-14:14-C',
      asOf: '2026-11-18',
      baseRevision: 1,
      deadline: null,
      eligibility: { careerStage: null, discipline: ['教育学'] },
      appliedNotices: [],
    },
  );
});

test('提醒写入后不可被原地篡改', () => {
  const { catalog, notices } = setup();
  const alerts = new AlertLog();
  const criteria = { states: ['active'] };
  alerts.send({
    id: 'AL-1',
    screenId: 'S-1',
    recipient: '学者甲',
    opportunity: { key: 'local:a', id: 'a' },
    criteria,
    conditions: {
      asOf: '2026-11-18',
      deadline: '2027-01-15',
      eligibility: { careerStage: ['early'] },
      appliedNotices: [],
    },
    notices: [],
    sentAt: '2026-11-18T09:00:00.000Z',
  });
  const explained = alerts.explain('AL-1');
  explained.rule.conditions.eligibility.careerStage.push('篡改');
  assert.deepEqual(alerts.explain('AL-1').rule.conditions.eligibility.careerStage, ['early']);

  // 提醒中的通知也只保存快照，不与通知日志共享对象。
  notices.attach(catalog, notice());
  assert.equal(alerts.explain('AL-1').noticesAtSend.length, 0);
  assert.throws(() => alerts.send({
    id: 'AL-1',
    screenId: 'S-1',
    recipient: '学者甲',
    opportunity: { key: 'local:a', id: 'a' },
    criteria,
    conditions: { asOf: '2026-11-18' },
    notices: [],
    sentAt: '2026-11-18T10:00:00.000Z',
  }), (error) => error.code === 'alert_conflict');
});
