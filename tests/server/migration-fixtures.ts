import type Sqlite from "better-sqlite3";

export function removeSavedArticleTimestampMigration(database: Sqlite.Database): void {
  database.exec(`
    DROP INDEX articles_starred_at_idx;
    ALTER TABLE articles DROP COLUMN starred_at;
    CREATE INDEX articles_starred_idx ON articles(is_starred);
  `);
}
