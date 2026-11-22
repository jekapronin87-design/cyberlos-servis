import type { CrmDashboardDto } from '../../shared/types';

/** Пример данных для показа интерфейса, пока CRM не подключена. Помечается на экране как «пример». */
export const SAMPLE_DASHBOARD: CrmDashboardDto = {
  overview: {
    pipelines: [
      { name: 'Заявки с сайта', slug: 'site', open: 24, won: 41, lost: 18, byStage: [{ name: 'Новый', open: 9, breaches: 3 }, { name: 'В работе', open: 7, breaches: 1 }, { name: 'Расчёт', open: 5, breaches: 0 }, { name: 'КП', open: 3, breaches: 1 }] },
      { name: 'Холодные дилеры', slug: 'cold', open: 31, won: 12, lost: 40, byStage: [{ name: 'Список', open: 14, breaches: 0 }, { name: 'Контакт', open: 10, breaches: 2 }, { name: 'Интерес', open: 5, breaches: 0 }, { name: 'Договор', open: 2, breaches: 0 }] },
      { name: 'Заявки дилеров', slug: 'dealers', open: 12, won: 27, lost: 5, byStage: [{ name: 'Новый', open: 4, breaches: 0 }, { name: 'Счёт', open: 5, breaches: 2 }, { name: 'Оплата', open: 3, breaches: 0 }] },
      { name: 'Производство', slug: 'prod', open: 15, won: 60, lost: 2, byStage: [{ name: 'Ожидает', open: 3, breaches: 1 }, { name: 'В цеху', open: 8, breaches: 2 }, { name: 'Сборка', open: 3, breaches: 0 }, { name: 'Отгрузка', open: 1, breaches: 0 }] },
    ],
    newLast24h: 7,
    unassignedOpen: 3,
    stuck: 12,
    tasksOpen: 46,
    tasksOverdue: 8,
    productionOpen: 15,
    productionOverdue: 3,
    awaitingPrepayment: 4,
    lowStock: 2,
  },
  managers: [
    { name: 'Менеджер А', role: 'sales', openDeals: 22, stuckDeals: 4, tasksOpen: 14, tasksOverdue: 3, doneOnTime: 31, doneLate: 4 },
    { name: 'Менеджер Б', role: 'sales', openDeals: 17, stuckDeals: 2, tasksOpen: 11, tasksOverdue: 1, doneOnTime: 28, doneLate: 2 },
    { name: 'Менеджер В', role: 'sales', openDeals: 26, stuckDeals: 6, tasksOpen: 21, tasksOverdue: 4, doneOnTime: 19, doneLate: 9 },
  ],
  issues: [
    { kind: 'stuck', dealId: '1', title: 'Пример', pipeline: 'Заявки с сайта', stage: 'Новый', who: [], detail: '' },
    { kind: 'stuck', dealId: '2', title: 'Пример', pipeline: 'Производство', stage: 'В цеху', who: [], detail: '' },
    { kind: 'no_next_action', dealId: '3', title: 'Пример', pipeline: 'Холодные дилеры', stage: 'Контакт', who: [], detail: '' },
    { kind: 'no_assignee', dealId: '4', title: 'Пример', pipeline: 'Заявки с сайта', stage: 'Новый', who: [], detail: '' },
    { kind: 'production_unpaid_in_work', dealId: '5', title: 'Пример', pipeline: 'Производство', stage: 'В цеху', who: [], detail: '' },
  ],
  needs: [{ employee: 'Менеджер В', total: 5, topics: [{ topic: 'Следующее действие', kind: 'no_next_action', count: 3 }] }],
  missing: [],
  truncated: false,
  at: new Date().toISOString(),
};
