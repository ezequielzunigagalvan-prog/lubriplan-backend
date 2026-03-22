// src/realtime/sseHub.js
export const sseHub = (() => {
  const clients = new Map(); // userId -> Set(res)

  const add = (userId, res) => {
    const key = String(userId);
    if (!clients.has(key)) clients.set(key, new Set());
    clients.get(key).add(res);
  };

  const remove = (userId, res) => {
    const key = String(userId);
    const set = clients.get(key);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) clients.delete(key);
  };

  const send = (userId, event, data) => {
    const key = String(userId);
    const set = clients.get(key);
    if (!set) return;

    const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {}
    }
  };

  const broadcast = (event, data) => {
    const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
    for (const set of clients.values()) {
      for (const res of set) {
        try {
          res.write(payload);
        } catch {}
      }
    }
  };

  return { add, remove, send, broadcast };
})();

export default sseHub;

