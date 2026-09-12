import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Local HTTPS via an mkcert-issued cert (repo root README "Local HTTPS") --
// falls back to plain HTTP if the cert files aren't present (a fresh clone
// or CI where `mkcert -install` was never run), matching server.js's same
// fallback so the two dev servers never disagree on protocol.
const keyPath = path.resolve(__dirname, '../certs/localhost-key.pem');
const certPath = path.resolve(__dirname, '../certs/localhost.pem');
// SW_DEV_HTTPS=0 forces plain HTTP even when the cert files exist -- needed
// right after generating certs but before the backend (server.js) has been
// restarted to actually serve TLS on :4000, since this dev server's proxy
// would otherwise point at a backend that isn't speaking HTTPS yet.
const hasTls = existsSync(keyPath) && existsSync(certPath) && process.env.SW_DEV_HTTPS !== '0';
const backendProtocol = hasTls ? 'https' : 'http';
const wsProtocol = hasTls ? 'wss' : 'ws';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    https: hasTls ? { key: readFileSync(keyPath), cert: readFileSync(certPath) } : undefined,
    proxy: {
      // secure: false -- the proxy is Node's own https client talking to
      // 127.0.0.1:4100; Node doesn't read the OS/browser trust store mkcert
      // installed into, so without this it would reject the cert as
      // self-signed even though the browser itself trusts it fine.
      '/api': { target: `${backendProtocol}://localhost:4100`, secure: false },
      '/ws': { target: `${wsProtocol}://localhost:4100`, ws: true, secure: false },
    },
  },
});
