/**
 * Tipos mínimos do `node:sqlite` (SQLite embutido do Node 22.13+).
 *
 * O projeto usa `@types/node@20`, que ainda não o conhece; subir os tipos do
 * Node para o projeto todo só por isto mexeria em código que não tem relação
 * com o gateway. Só o que o gateway usa está declarado.
 */
declare module "node:sqlite" {
  type SqlValue = string | number | bigint | null | Uint8Array;

  interface StatementSync {
    run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: SqlValue[]): Record<string, unknown> | undefined;
    all(...params: SqlValue[]): Record<string, unknown>[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
