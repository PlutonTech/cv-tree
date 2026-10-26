// SQLite schema shared by the analytics server and the demo-data script.
import { DatabaseSync } from "node:sqlite";

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, install TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL, day TEXT NOT NULL,
      props TEXT NOT NULL DEFAULT '{}', version TEXT, received INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ev_day ON events(day);
    CREATE INDEX IF NOT EXISTS ev_type ON events(type, day);
    CREATE INDEX IF NOT EXISTS ev_install ON events(install, at);
    CREATE TABLE IF NOT EXISTS installs (
      install TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
      version TEXT, browser TEXT, locale TEXT, events INTEGER NOT NULL DEFAULT 0);`);
  return db;
}
