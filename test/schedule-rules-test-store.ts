import type {
  ScheduleRulesStore,
  StoredConfigRow,
} from "../app/services/schedule-rules.server";

interface ConfigTableMock {
  findUnique: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<unknown>;
}

/** ScheduleRulesStore over a DeliveryScheduleConfig-shaped table mock. */
export function tableBackedStore(table: ConfigTableMock, shop: string): ScheduleRulesStore {
  return {
    async read() {
      return (await table.findUnique({ where: { shop } })) as StoredConfigRow | null;
    },
    async create(row) {
      try {
        return (await table.create({ data: { shop, ...row } })) as StoredConfigRow;
      } catch (error) {
        if ((error as { code?: string })?.code === "P2002") {
          return null;
        }
        throw error;
      }
    },
    async update(row, expectedVersion) {
      const updated = (await table.updateMany({
        where: { shop, version: expectedVersion },
        data: { shop, ...row },
      })) as { count: number };
      return updated.count > 0;
    },
  };
}
