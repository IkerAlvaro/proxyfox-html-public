// boot.js: runs first in the Proxyfox Isolated Web App, before app.js (a classic script in <head>).
//
// 1. Trusted Types. An IWA's fixed CSP requires them for every script URL and HTML sink. The app
//    only ever loads its own files (the CSP keeps script-src to 'self' anyway), so a pass-through
//    default policy is enough. The engine's workers get the same at the top of gecko-glue.js.
//
// 2. Direct Sockets. An IWA may open TCP and UDP connections itself (TCPSocket, UDPSocket). Proxyfox
//    reaches the internet through a WISP relay: a WebSocket that carries many TCP/UDP streams.
//    Here the WebSocket the app opens to its relay is answered by a WISP server inside the app,
//    which opens each stream as a real socket from this device. No relay: no third party in the
//    middle, no relay to go down, no relay's speed limit, and one network hop less.
//    Turned off (back to the relays) with ?relays in the address, or
//    localStorage['proxyfox-iwa-network'] = 'relays'; it is off where TCPSocket isn't available.
(() => {
  if (self.trustedTypes && !self.trustedTypes.defaultPolicy) {
    self.trustedTypes.createPolicy('default', { createHTML: (s) => s, createScriptURL: (s) => s, createScript: (s) => s });
  }

  const KEY = 'proxyfox-iwa-network';
  let mode = 'direct';
  try { mode = localStorage.getItem(KEY) || 'direct'; } catch {}
  if (new URLSearchParams(location.search).has('relays')) mode = 'relays';
  if (typeof TCPSocket !== 'function') {
    console.log('[proxyfox iwa] network: through the WISP relays (this browser gives this app no Direct Sockets)');
    return;
  }
  if (mode !== 'direct') {
    console.log('[proxyfox iwa] network: through the WISP relays (chosen)');
    return;
  }

  // The app asks which web filter the person is behind, to order its relays. Direct Sockets use no
  // relay, so there is nothing to order: leave it chosen (a choice already made is kept).
  try { if (!localStorage.getItem('proxyfox-filter')) localStorage.setItem('proxyfox-filter', 'Not sure'); } catch {}

  // --- What an installed app can do that a tab can't --------------------------------------------------
  // Everything here is best effort: a browser that refuses leaves Proxyfox exactly as it was.
  addEventListener('DOMContentLoaded', () => {
    // Screen wake lock: kept while the window is visible (the browser drops it when it is hidden).
    let lock = null;
    const hold = async () => {
      try {
        if (document.visibilityState !== 'visible' || lock || !navigator.wakeLock) return;
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch { lock = null; }
    };
    document.addEventListener('visibilitychange', hold);
    // Keyboard lock: the browser's own shortcuts (new tab, close tab, next tab ...) reach Firefox. The
    // browser allows it in full screen and in standalone windows; asked again when full screen changes.
    const grab = () => {
      try {
        navigator.keyboard?.lock(['KeyT', 'KeyW', 'KeyN', 'KeyL', 'KeyR', 'KeyD', 'KeyF', 'KeyK', 'Tab', 'Escape', 'F5', 'F11']).catch(() => {});
      } catch {}
    };
    addEventListener('pointerdown', () => { hold(); grab(); }, { once: true });
    document.addEventListener('fullscreenchange', grab);
  });

  const NativeWebSocket = self.WebSocket;
  const T = { CONNECT: 1, DATA: 2, CONTINUE: 3, CLOSE: 4, INFO: 5 };
  const R = { VOLUNTARY: 0x02, NETWORK: 0x03, UNREACHABLE: 0x42, REFUSED: 0x44 };
  const BUFFER = 256; // packets a stream may send before it hears CONTINUE
  const MAX_DATA = 1 << 16; // bytes per DATA packet from a socket
  const dec = new TextDecoder();

  const packet = (type, id, payload) => {
    const p = new Uint8Array(5 + payload.length);
    p[0] = type;
    new DataView(p.buffer).setUint32(1, id, true);
    p.set(payload, 5);
    return p;
  };
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

  let connections = 0, streamsOpened = 0;

  // One WISP connection, answered here: what the app takes for a WebSocket to a relay.
  class DirectWisp extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;

    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.binaryType = 'blob';
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      const list = protocols == null ? [] : [].concat(protocols);
      this.v2 = list.includes('wisp-v2');
      this.streams = new Map();
      connections++;
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.fire(new Event('open'));
        // WISP v2: INFO first (version 2.0, the UDP extension: id 1, empty payload), then CONTINUE.
        if (this.v2) this.deliver(packet(T.INFO, 0, Uint8Array.of(2, 0, 1, 0, 0, 0, 0)));
        this.deliver(packet(T.CONTINUE, 0, u32(BUFFER)));
      }, 0);
    }
    get protocol() { return this.v2 ? 'wisp-v2' : ''; }
    get extensions() { return ''; }
    get bufferedAmount() { return 0; }

    fire(ev) {
      const h = this['on' + ev.type];
      if (typeof h === 'function') h.call(this, ev);
      this.dispatchEvent(ev);
    }
    deliver(bytes) {
      if (this.readyState !== 1) return;
      const data = this.binaryType === 'arraybuffer'
        ? (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer)
        : new Blob([bytes]);
      this.fire(new MessageEvent('message', { data }));
    }

    send(data) {
      if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      if (typeof data === 'string') return this.receive(new TextEncoder().encode(data));
      if (data instanceof Blob) return void data.arrayBuffer().then((b) => this.receive(new Uint8Array(b)));
      if (data instanceof ArrayBuffer) return this.receive(new Uint8Array(data));
      if (ArrayBuffer.isView(data)) return this.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      throw new TypeError('invalid data to send');
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      for (const id of [...this.streams.keys()]) this.drop(id);
      setTimeout(() => {
        this.readyState = 3;
        this.fire(new CloseEvent('close', { code, reason, wasClean: true }));
      }, 0);
    }

    // A packet from the app.
    receive(p) {
      if (p.length < 5) return;
      const type = p[0], id = new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(1, true), body = p.subarray(5);
      if (type === T.CONNECT && body.length >= 3) {
        const port = body[1] | (body[2] << 8);
        void this.open(id, body[0], dec.decode(body.subarray(3)), port);
      } else if (type === T.DATA) {
        this.write(id, body.slice()); // the app may reuse its buffer
      } else if (type === T.CLOSE) {
        this.drop(id);
      } // CONTINUE and INFO from a client need no answer
    }

    async open(id, kind, host, port) {
      const s = { kind, socket: null, reader: null, writer: null, queue: [], sent: 0, done: false };
      this.streams.set(id, s);
      streamsOpened++;
      try {
        s.socket = kind === 2
          ? new UDPSocket({ remoteAddress: host, remotePort: port })
          : new TCPSocket(host, port, { noDelay: true, keepAliveDelay: 60000 });
        const { readable, writable } = await s.socket.opened;
        if (s.done) { try { s.socket.close(); } catch {} return; }
        s.writer = writable.getWriter();
        const queued = s.queue;
        s.queue = null;
        for (const b of queued) this.write(id, b);
        s.reader = readable.getReader();
        await this.pump(id, s, s.reader);
      } catch (e) {
        if (!s.done) {
          console.warn(`[proxyfox iwa] ${kind === 2 ? 'udp' : 'tcp'} ${host}:${port}: ${e?.message || e}`);
          this.end(id, s.writer ? R.NETWORK : (/refused/i.test(String(e?.message)) ? R.REFUSED : R.UNREACHABLE));
        }
      }
    }
    async pump(id, s, reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || s.done) break;
        const bytes = s.kind === 2 ? value.data : value;
        for (let at = 0; at < bytes.length; at += MAX_DATA) this.deliver(packet(T.DATA, id, bytes.subarray(at, at + MAX_DATA)));
      }
      if (!s.done) this.end(id, R.VOLUNTARY);
    }
    write(id, bytes) {
      const s = this.streams.get(id);
      if (!s || s.done) return;
      if (!s.writer) { s.queue.push(bytes); return; }
      s.writer.write(s.kind === 2 ? { data: bytes } : bytes).then(() => {
        // TCP: let the app send more once its packets went out (UDP streams aren't counted).
        if (s.kind !== 2 && ++s.sent >= BUFFER / 2 && !s.done) {
          s.sent = 0;
          this.deliver(packet(T.CONTINUE, id, u32(BUFFER)));
        }
      }, () => this.end(id, R.NETWORK));
    }
    // The socket ended: tell the app.
    end(id, reason) {
      if (!this.streams.has(id)) return;
      this.drop(id);
      this.deliver(packet(T.CLOSE, id, Uint8Array.of(reason)));
    }
    // Forget a stream and close its socket.
    drop(id) {
      const s = this.streams.get(id);
      if (!s) return;
      this.streams.delete(id);
      s.done = true;
      // A socket whose streams are locked can't be closed directly: ending both streams closes it.
      if (s.reader || s.writer) {
        s.reader?.cancel().catch(() => {});
        s.writer?.close().catch(() => {});
      } else {
        s.socket?.opened.then(() => s.socket.close(), () => {}).catch(() => {});
      }
    }
  }

  self.WebSocket = DirectWisp;
  self.__proxyfoxNativeWebSocket = NativeWebSocket;
  self.__proxyfoxDirect = { stats: () => ({ connections, streamsOpened }), relays: () => { try { localStorage.setItem(KEY, 'relays'); } catch {} location.reload(); }, direct: () => { try { localStorage.removeItem(KEY); } catch {} location.reload(); } };
  console.log('[proxyfox iwa] network: Direct Sockets, straight from this device (no WISP relay). __proxyfoxDirect.relays() goes back to the relays');
})();
