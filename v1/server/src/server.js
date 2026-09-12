/**
 * Boot sequence follows docs/activity_flows.md §4: connect DB, hydrate
 * indicator state, rebuild filter membership, THEN start the scheduler --
 * never the other way around, or an ingest cycle could run against
 * partially-initialized state.
 *
 * v1 (stable, Yahoo-only, Nifty 50): no NSE/Playwright automation, no
 * watch-folder/manual-CSV path -- Yahoo Finance is the sole data source
 * (scheduler.js), reached only via the built-in connection. The
 * multi-connection registry (DbManager/registry.js) and the broker-bridge
 * scaffolding (Fyers) are unchanged from v2 -- see docs/architecture.md §2b
 * -- but v1 has no frontend UI to add/switch connections; it always just
 * boots the one active built-in one.
 */
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import multipartPlugin from '@fastify/multipart';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { config } from './config.js';
import { ConnectionRegistry } from './db/registry.js';
import { DbManager } from './db/dbManager.js';
import { IndicatorEngine } from './indicators/state.js';
import { FilterEngine } from './filters/engine.js';
import { Broadcaster } from './ws/broadcaster.js';
import { IngestPipeline } from './ingest/ingestPipeline.js';
import { BrokerBridge } from './datasource/broker/BrokerBridge.js';
import { FyersClient } from './datasource/broker/fyers/FyersClient.js';
import { Scheduler } from './scheduler.js';
import { nowIst } from './time.js';

// Every broker BrokerBridge.js can drive, keyed by registry.js's
// `brokerType` -- adding a second broker later is one new entry here plus
// its own BrokerClient implementation under datasource/broker/<name>/,
// never a change to BrokerBridge itself or to this dispatch.
const BROKER_CLIENTS = {
  fyers: FyersClient,
};

import { registerSnapshotRoutes } from './routes/snapshot.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerFilterRoutes } from './routes/filters.js';
import { registerWsRoute } from './routes/ws.js';
import { registerClassificationRoutes } from './routes/classification.js';
import { registerSchedulerRoutes } from './routes/scheduler.js';
import { registerMonitorRoutes } from './routes/monitor.js';
import { registerDataConnectionRoutes } from './routes/dataConnections.js';
import { registerSymbolsRoutes } from './routes/symbols.js';
import { registerBrokerRoutes } from './routes/broker.js';
import { registerBackfillRoutes } from './routes/backfill.js';
import { registerSystemHealthRoutes } from './routes/systemHealth.js';
import { startHealthHistorySampler } from './health/history.js';
import { httpLatency } from './health/metrics.js';
import { DEFAULT_COLOR_RULES } from './routes/settings.js';

export async function buildServer(overrides = {}) {
  for (const dir of [path.dirname(config.dbPath), path.dirname(config.registryPath), config.sourcesDir, config.checkpointsDir, config.logsDir]) {
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const registry = new ConnectionRegistry(config.registryPath, config.dbPath, config.sourcesDir);
  const dbManager = new DbManager(registry);
  const broadcaster = new Broadcaster();

  /** @type {any} mutated in place by activateConnection -- never reassigned */
  const ctx = { registry, dbManager, broadcaster, connectionId: null, logsDir: config.logsDir };

  async function activateConnection(connectionId) {
    if (ctx.adapter) await ctx.adapter.stop();
    if (ctx.scheduler) ctx.scheduler.stop();

    const db = await dbManager.getOrOpen(connectionId);

    const indicatorEngine = new IndicatorEngine();
    await indicatorEngine.hydrateFromDb(db);

    let classificationCache = await db.readClassificationMap();
    const getClassification = () => classificationCache;
    const refreshClassification = async () => { classificationCache = await db.readClassificationMap(); };

    // FilterEngine reads colorRules synchronously -- cache it rather than
    // handing it an async getter (see docs/issues.md, 2026-09-09).
    let colorRulesCache = (await db.readSetting('colorRules')) ?? DEFAULT_COLOR_RULES;
    const getColorRules = () => colorRulesCache;
    const refreshColorRules = async () => { colorRulesCache = (await db.readSetting('colorRules')) ?? DEFAULT_COLOR_RULES; };

    let superFilterCache = (await db.readSetting('super_filter')) ?? 'all';
    const refreshSuperFilter = async () => { superFilterCache = (await db.readSetting('super_filter')) ?? 'all'; };

    const filterEngine = new FilterEngine(db, getColorRules, getClassification, config.logsDir);
    const initialSnapshot = await db.readLatestSnapshot();
    await filterEngine.hydrate(initialSnapshot);

    let universeCache = new Set((await db.all('SELECT symbol FROM symbols')).map((r) => r.symbol));
    const refreshUniverse = async () => {
      universeCache = new Set((await db.all('SELECT symbol FROM symbols')).map((r) => r.symbol));
    };

    const pipeline = new IngestPipeline({
      db, indicatorEngine, filterEngine, broadcaster,
      getFullUniverse: () => universeCache,
      getActiveSuperFilter: () => superFilterCache,
    });

    const connection = registry.get(connectionId);
    let scheduler = null;
    let adapter = null;
    let brokerClient = null;

    if (connection?.kind === 'broker') {
      const BrokerClientClass = BROKER_CLIENTS[connection.brokerType];
      if (!BrokerClientClass) throw new Error(`Unknown brokerType: ${connection.brokerType}`);
      brokerClient = new BrokerClientClass({ db, nowIst });
      adapter = new BrokerBridge({
        client: brokerClient,
        getUniverse: async () => {
          await refreshUniverse();
          return universeCache;
        },
        nowIst,
        getScheduleConfig: () => db.readSchedulerConfig(),
      });
      adapter.onCycle(async (bars, meta) => {
        await ctx.pipeline.runCycle(meta.scheduledTsIst, bars, meta);
      });
      adapter.start();
    } else {
      // The built-in Yahoo Finance connection -- no adapter needed;
      // scheduler.js fetches and calls pipeline.runCycle() directly.
      scheduler = new Scheduler(db, {
        pipeline: () => ctx.pipeline,
        getFullUniverse: () => universeCache,
        connectionId,
      });
      await scheduler.init();
    }

    Object.assign(ctx, {
      connectionId, db, indicatorEngine, filterEngine, pipeline, adapter, scheduler, brokerClient,
      getClassification, refreshClassification, getColorRules, refreshColorRules, refreshSuperFilter,
    });
  }

  await activateConnection(registry.getActiveId());
  startHealthHistorySampler({ ctx, config });

  // Local HTTPS via an mkcert-issued cert (README "Local HTTPS") -- falls
  // back to plain HTTP if the cert files aren't present (a fresh clone or
  // CI where `mkcert -install` was never run), so this never blocks boot.
  const hasTls = existsSync(config.tlsKeyPath) && existsSync(config.tlsCertPath);
  const app = Fastify({
    logger: true,
    ...(hasTls ? { https: { key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) } } : {}),
  });
  await app.register(websocketPlugin);
  await app.register(multipartPlugin, { limits: { fileSize: 25 * 1024 * 1024 } });

  app.addHook('onResponse', async (req, reply) => {
    httpLatency.record(reply.elapsedTime, reply.statusCode);
  });

  registerSnapshotRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerFilterRoutes(app, ctx);
  registerWsRoute(app, ctx);
  registerClassificationRoutes(app, ctx);
  registerSchedulerRoutes(app, ctx);
  registerMonitorRoutes(app, ctx);
  registerDataConnectionRoutes(app, ctx, activateConnection);
  registerSymbolsRoutes(app, ctx);
  registerBrokerRoutes(app, ctx);
  registerBackfillRoutes(app, ctx);
  registerSystemHealthRoutes(app, ctx);

  app.addHook('onClose', async () => {
    if (ctx.adapter) await ctx.adapter.stop();
    if (ctx.scheduler) ctx.scheduler.stop();
    await dbManager.closeAll();
  });

  return { app, ctx };
}

// Only actually start listening when run directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { app } = await buildServer();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  const hasTls = existsSync(config.tlsKeyPath) && existsSync(config.tlsCertPath);
  app.log.info(hasTls ? `Serving HTTPS on port ${config.port} (mkcert)` : `Serving plain HTTP on port ${config.port} -- no cert at ${config.tlsCertPath}, see README "Local HTTPS"`);

  // Without this, a Ctrl+C or `Stop-Process` skips the onClose hook above
  // entirely -- DuckDB never gets a chance to flush its WAL. A graceful
  // signal now always closes cleanly first; only a hard kill (-9 /
  // Stop-Process -Force, which can't be intercepted) still risks it.
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      app.log.info(`${signal} received, closing DB connections cleanly...`);
      try {
        await app.close();
      } finally {
        process.exit(0);
      }
    });
  }
}
