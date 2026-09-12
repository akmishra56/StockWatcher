/**
 * Owns one DbClient per registered connection, opened lazily and cached --
 * so switching the active connection in Settings never re-reads or
 * re-writes another connection's database. Each connection's DbClient runs
 * the identical schema.sql, so every connection has the same tables; what
 * differs is which physical file backs it.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DbClient } from './client.js';

export class DbManager {
  constructor(registry) {
    this.registry = registry;
    /** @type {Map<string, DbClient>} */
    this.clients = new Map();
  }

  async getOrOpen(connectionId) {
    const existing = this.clients.get(connectionId);
    if (existing) return existing;

    const connection = this.registry.get(connectionId);
    if (!connection) throw new Error(`Unknown connection: ${connectionId}`);

    mkdirSync(path.dirname(connection.dbPath), { recursive: true });
    const db = new DbClient(connection.dbPath);
    await db.init();
    this.clients.set(connectionId, db);
    return db;
  }

  async closeAll() {
    for (const db of this.clients.values()) await db.close();
    this.clients.clear();
  }
}
