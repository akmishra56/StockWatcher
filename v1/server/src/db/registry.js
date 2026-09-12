/**
 * The connection registry: which data-source "connections" exist (each
 * backed by its own fully-isolated DuckDB file, same schema) and which one
 * is currently active. Persisted as a small JSON file rather than a DuckDB
 * table because it has to be readable *before* any per-connection database
 * is opened -- it's the thing that tells the app which database to open.
 *
 * v1 ships one built-in connection ('yahoo-finance') and has no frontend UI
 * to add or switch connections today -- it always just boots the one active
 * built-in one. A broker connection (e.g. Fyers) is kept as a registered-but-
 * inactive placeholder, same as v2, in case broker support is added to v1
 * later; the registry/BrokerBridge machinery itself is unchanged from v2.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_CONNECTIONS = [
  { id: 'yahoo-finance', label: 'Yahoo Finance', kind: 'csv', dbPath: null, isBuiltIn: true },
  // Not a real, activatable connection yet -- Fyers' endpoint shapes are
  // sourced from public docs, unverified against a live account (see
  // docs/researchOutput.md). Shown so the broker bridge is visible without
  // implying it can be switched to today.
  { id: 'fyers-placeholder', label: 'Fyers', kind: 'broker', brokerType: 'fyers', dbPath: null, isBuiltIn: true, isPlaceholder: true },
];

export class ConnectionRegistry {
  /**
   * @param {string} registryPath  path to the registry JSON file
   * @param {string} defaultDbPath  dbPath to seed the built-in connection with on first boot
   * @param {string} sourcesDir  directory new (non-built-in) connections' DB files are created under
   */
  constructor(registryPath, defaultDbPath, sourcesDir) {
    this.registryPath = registryPath;
    this.defaultDbPath = defaultDbPath;
    this.sourcesDir = sourcesDir;
    this.state = this._load();
  }

  _load() {
    if (existsSync(this.registryPath)) {
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      let dirty = false;
      // Backfill the built-in connection's dbPath if a registry from before
      // it existed is missing it (shouldn't happen post-migration, but cheap to guard).
      for (const c of parsed.connections) {
        if (c.id === 'yahoo-finance' && !c.dbPath) {
          c.dbPath = this.defaultDbPath;
          dirty = true;
        }
      }
      // A registry saved before the Fyers placeholder existed won't have it yet.
      if (!parsed.connections.some((c) => c.id === 'fyers-placeholder')) {
        parsed.connections.push(DEFAULT_CONNECTIONS.find((c) => c.id === 'fyers-placeholder'));
        dirty = true;
      }
      if (dirty) this._save(parsed);
      return parsed;
    }
    const connections = DEFAULT_CONNECTIONS.map((c) => (c.id === 'yahoo-finance' ? { ...c, dbPath: this.defaultDbPath } : c));
    const state = { activeId: 'yahoo-finance', connections };
    this._save(state);
    return state;
  }

  _save(state = this.state) {
    mkdirSync(path.dirname(this.registryPath), { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(state, null, 2));
  }

  list() {
    return this.state.connections;
  }

  getActiveId() {
    return this.state.activeId;
  }

  get(id) {
    return this.state.connections.find((c) => c.id === id);
  }

  /** @throws if the connection doesn't exist */
  setActive(id) {
    if (!this.get(id)) throw new Error(`Unknown connection: ${id}`);
    this.state.activeId = id;
    this._save();
  }

  /**
   * Registers a new connection. Never touches an existing connection's
   * dbPath. `brokerType` (e.g. 'fyers') is only meaningful when
   * `kind === 'broker'` -- it's how server.js's activateConnection picks
   * which BrokerClient implementation to instantiate (see
   * datasource/broker/), the same way `kind === 'csv'` always means the
   * Yahoo Finance path today.
   */
  add({ id, label, kind, brokerType = null }) {
    if (this.get(id)) throw new Error(`Connection already exists: ${id}`);
    const dbPath = path.join(this.sourcesDir, `${id}.duckdb`);
    const connection = { id, label, kind, brokerType, dbPath, isBuiltIn: false };
    this.state.connections.push(connection);
    this._save();
    return connection;
  }
}
