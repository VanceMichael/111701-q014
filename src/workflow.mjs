import { loadCatalog } from './pipeline.mjs';
import { conditionsAt } from './notices.mjs';
import { ScreenStore } from './screening.mjs';
import { AlertLog, prepareAlert, compareWithCurrent } from './alerts.mjs';

const TODAY = '2026-11-18';
const SENT_AT = '2026-11-18T09:00:00.000Z';

// 演示范例：用仓库自带的合成数据走完整条链路——
// 原页面采集 → 补充通知绑定 → 保存筛选 → 重算 → 已发提醒解释。
export async function demo() {
  const { catalog, notices } = await loadCatalog();
  const screens = new ScreenStore();
  const alerts = new AlertLog();
  const criteria = {
    states: ['active'],
    deadlineOnOrAfter: '2026-12-01',
    eligibility: { careerStage: ['mid'], discipline: ['化学'] },
  };

  // 1. 原页面：补充通知生效前的筛选。
  const screen = screens.save({
    id: 'S-1',
    name: '中期化学学者机会',
    criteria,
    asOf: '2026-11-17',
    catalog,
    notices,
  });

  // 2. 选出可提醒的项目并冻结当时的规则。生效前入选的是 14-B；
  //    补充通知随后收紧了它的学科范围。
  const target = screen.current.results[0];
  const sent = target
    ? alerts.send({
        id: 'AL-1',
        screenId: 'S-1',
        recipient: '学者甲',
        sentAt: SENT_AT,
        note: '按 11 月 17 日页面与当时通知推荐',
        ...prepareAlert({
          screen,
          result: target,
          asOf: '2026-11-17',
          catalog,
          notices,
        }),
      })
    : null;

  // 3. 补充通知自 11 月 18 日生效：用同一批保存的条件重新判断。
  const reevaluation = screens.reevaluate('S-1', {
    asOf: TODAY,
    catalog,
    notices,
    now: '2026-11-18T09:30:00.000Z',
  });

  const explanation = sent ? alerts.explain('AL-1') : null;
  const comparison = sent
    ? compareWithCurrent(sent, conditionsAt(catalog, notices, sent.opportunity.key, TODAY))
    : null;

  return {
    originalPage: {
      observedAt: catalog.sources.find((page) => page.source === 'sample-14')?.observedAt ?? null,
      items: catalog.opportunities.map((opportunity) => ({
        id: opportunity.id,
        deadline: opportunity.baseConditions.deadline,
        eligibility: opportunity.baseConditions.eligibility,
      })),
    },
    notices: notices.all().map((notice) => ({
      id: notice.id,
      target: notices.targetOf(notice.id)?.key ?? null,
      effectiveFrom: notice.effectiveFrom,
      changes: notice.changes,
    })),
    screenBefore: {
      asOf: screen.current.asOf,
      criteria: screen.current.criteria,
      results: screen.current.results.map((entry) => entry.id),
    },
    reevaluation,
    alert: explanation,
    comparison,
  };
}

if (
  typeof process !== 'undefined' &&
  process.argv?.[1] &&
  import.meta.url === `file://${process.argv[1]}`
) {
  const result = await demo();
  console.log(JSON.stringify(result, null, 2));
}
