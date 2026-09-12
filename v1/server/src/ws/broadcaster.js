/**
 * Fan-out to every connected WebSocket client. See docs/component_design.md §5.
 */
export class Broadcaster {
  constructor() {
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
  }

  add(socket) {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
  }

  publish(...messages) {
    const payloads = messages.map((m) => JSON.stringify(m));
    for (const client of this.clients) {
      if (client.readyState === 1 /* OPEN */) {
        for (const payload of payloads) client.send(payload);
      }
    }
  }
}
