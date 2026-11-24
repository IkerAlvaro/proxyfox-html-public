// A small HTTPS GET over a WISP relay: WISP v1 for the TCP connection, TLS 1.3 done with the
// browser's own crypto (WebCrypto). Based on zaka13alt's loader.
//
// It speaks just enough TLS 1.3 for GitHub's file servers: TLS_AES_128_GCM_SHA256 with a P-256
// key exchange. It does NOT check the server's certificate, so on its own a relay could answer
// in GitHub's place. That's why loader.js only runs a file whose signature checks out.

const enc = new TextEncoder();
// A relay has this long to open and to get the TLS handshake with GitHub done.
const CONNECT_MS = 3000;
const subtle = crypto.subtle;

const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const bytes = (...xs) => Uint8Array.from(xs.flat());
const u16 = (n) => [(n >> 8) & 255, n & 255];
const u24 = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];

// One WISP stream (id 1) over its own WebSocket. Incoming data is kept as a list of chunks and read
// out exactly, without copying what's still waiting (an 86 MB download stays linear).
function wispOpen(relay, host, port, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error(`${relay}: cancelled`));
    const ws = new WebSocket(relay);
    ws.binaryType = 'arraybuffer';
    const chunks = [];
    let have = 0, closed = false, waiter = null, opened = false;
    // How long the relay may stay silent: CONNECT_MS until the TLS handshake is done (a relay that
    // doesn't get going is skipped fast), then 20 s during the download.
    let quietMs = CONNECT_MS;
    const wake = () => { const w = waiter; waiter = null; w?.(); };
    const packet = (type, payload) => {
      const p = new Uint8Array(5 + payload.length);
      p[0] = type;
      new DataView(p.buffer).setUint32(1, 1, true);
      p.set(payload, 5);
      return p;
    };
    const pipe = {
      connected: () => { quietMs = 20000; },
      send: (b) => ws.send(packet(2, b)),
      close: () => { closed = true; wake(); try { ws.close(); } catch {} },
      // Bytes already here, and the first n of them without taking them (null if fewer arrived).
      have: () => have,
      peek(n) {
        if (have < n) return null;
        const out = new Uint8Array(n);
        for (let o = 0, i = 0; o < n; i++) {
          const c = chunks[i], take = Math.min(c.length, n - o);
          out.set(c.subarray(0, take), o);
          o += take;
        }
        return out;
      },
      async read(n) {
        while (have < n) {
          if (closed) return null;
          // A relay that stops answering (20 s with nothing) counts as closed: the next one is tried.
          let timer;
          const quiet = await new Promise((r) => { waiter = () => r(false); timer = setTimeout(() => r(true), quietMs); });
          clearTimeout(timer); // one pending timer per wait, not thousands over a download
          if (quiet && have < n) { closed = true; try { ws.close(); } catch {} return null; }
        }
        const out = new Uint8Array(n);
        for (let o = 0; o < n;) {
          const c = chunks[0], take = Math.min(c.length, n - o);
          out.set(take === c.length ? c : c.subarray(0, take), o);
          o += take;
          if (take === c.length) chunks.shift(); else chunks[0] = c.subarray(take);
        }
        have -= n;
        return out;
      },
    };
    const timer = setTimeout(() => { if (!opened) { ws.close(); reject(new Error(`${relay}: no answer in ${CONNECT_MS / 1000} s`)); } }, CONNECT_MS);
    // Cancelled (another relay won the race): closes the socket; a pending read sees it closed.
    signal?.addEventListener('abort', () => {
      if (!opened) { clearTimeout(timer); reject(new Error(`${relay}: cancelled`)); }
      pipe.close();
    }, { once: true });
    ws.onopen = () => {
      if (signal?.aborted) return;
      opened = true;
      clearTimeout(timer);
      ws.send(packet(1, cat(bytes(1, port & 255, (port >> 8) & 255), enc.encode(host))));
      resolve(pipe);
    };
    ws.onmessage = (e) => {
      const m = new Uint8Array(e.data);
      if (m.length < 5 || new DataView(m.buffer).getUint32(1, true) !== 1) return;
      if (m[0] === 2) { const c = m.subarray(5); chunks.push(c); have += c.length; wake(); }
      else if (m[0] === 4) { closed = true; wake(); }
    };
    ws.onerror = () => { if (!opened) { clearTimeout(timer); reject(new Error(`${relay}: couldn't connect`)); } };
    ws.onclose = () => { closed = true; wake(); };
  });
}

const sha256 = async (d) => new Uint8Array(await subtle.digest('SHA-256', d));
const hmac = async (key, data) => new Uint8Array(await subtle.sign('HMAC',
  await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), data));
const expandLabel = async (secret, label, context, length) => {
  const l = enc.encode(`tls13 ${label}`);
  return (await hmac(secret, cat(bytes(u16(length), l.length), l, bytes(context.length), context, bytes(1)))).slice(0, length);
};

class Cipher {
  static async from(secret) {
    const c = new Cipher();
    c.key = await subtle.importKey('raw', await expandLabel(secret, 'key', new Uint8Array(0), 16), 'AES-GCM', false, ['encrypt', 'decrypt']);
    c.iv = await expandLabel(secret, 'iv', new Uint8Array(0), 12);
    c.seq = 0;
    return c;
  }
  nonce() {
    const n = this.iv.slice();
    for (let i = 0; i < 4; i++) n[11 - i] ^= (this.seq >>> (8 * i)) & 255;
    this.seq++;
    return n;
  }
  async seal(type, data) {
    const inner = cat(data, bytes(type));
    const head = bytes(23, 3, 3, u16(inner.length + 16));
    return cat(head, new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: this.nonce(), additionalData: head }, this.key, inner)));
  }
  async open(head, body) {
    const pt = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: this.nonce(), additionalData: head }, this.key, body));
    let i = pt.length - 1;
    while (i >= 0 && pt[i] === 0) i--;
    return [pt[i], pt.subarray(0, i)];
  }
}

async function readRecord(pipe) {
  const head = await pipe.read(5);
  if (!head) return null;
  const body = await pipe.read((head[3] << 8) | head[4]);
  return body && { head, type: head[0], body };
}

async function tlsConnect(pipe, host) {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const sni = enc.encode(host);
  const sigs = [0x0403, 0x0804, 0x0401, 0x0503, 0x0805, 0x0501, 0x0806].flatMap(u16);
  const ext = cat(
    bytes(u16(0), u16(sni.length + 5), u16(sni.length + 3), 0, u16(sni.length)), sni, // server name
    bytes(u16(10), u16(4), u16(2), u16(0x17)), // supported groups: P-256
    bytes(u16(13), u16(sigs.length + 2), u16(sigs.length), sigs), // signature algorithms
    bytes(u16(43), u16(3), 2, 3, 4), // supported versions: TLS 1.3
    bytes(u16(51), u16(71), u16(69), u16(0x17), u16(65)), pub, // key share
  );
  const body = cat(bytes(u16(0x0303)), crypto.getRandomValues(new Uint8Array(32)), bytes(32), crypto.getRandomValues(new Uint8Array(32)),
    bytes(u16(2), u16(0x1301), 1, 0, u16(ext.length)), ext);
  const hello = cat(bytes(1, u24(body.length)), body);
  pipe.send(cat(bytes(22, 3, 1, u16(hello.length)), hello));

  let rec;
  do { rec = await readRecord(pipe); if (!rec) throw new Error('the connection closed during the TLS handshake'); } while (rec.type === 20);
  if (rec.type === 21) throw new Error(`TLS alert ${rec.body[1]}`);
  const sh = rec.body;
  let p = 4 + 2 + 32;
  p += 1 + sh[p];
  if (((sh[p] << 8) | sh[p + 1]) !== 0x1301) throw new Error('the server chose a cipher this loader lacks');
  p += 3;
  const extEnd = p + 2 + ((sh[p] << 8) | sh[p + 1]);
  p += 2;
  let serverPub = null;
  while (p < extEnd) {
    const t = (sh[p] << 8) | sh[p + 1], l = (sh[p + 2] << 8) | sh[p + 3];
    if (t === 51) serverPub = sh.slice(p + 8, p + 4 + l);
    p += 4 + l;
  }
  if (!serverPub || serverPub.length !== 65) throw new Error('the server sent no P-256 key share');

  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', serverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, kp.privateKey, 256));
  const zeros = new Uint8Array(32), emptyHash = await sha256(new Uint8Array(0));
  const hsSecret = await hmac(await expandLabel(await hmac(zeros, zeros), 'derived', emptyHash, 32), shared);
  const transcript = [hello, sh];
  const helloHash = await sha256(cat(...transcript));
  const cHs = await expandLabel(hsSecret, 'c hs traffic', helloHash, 32);
  const sHsCipher = await Cipher.from(await expandLabel(hsSecret, 's hs traffic', helloHash, 32));
  const cHsCipher = await Cipher.from(cHs);

  let hs = new Uint8Array(0), finished = false;
  while (!finished) {
    rec = await readRecord(pipe);
    if (!rec) throw new Error('the connection closed during the TLS handshake');
    if (rec.type === 20) continue;
    if (rec.type === 21) throw new Error(`TLS alert ${rec.body[1]}`);
    const [t, inner] = await sHsCipher.open(rec.head, rec.body);
    if (t === 21) throw new Error(`TLS alert ${inner[1]}`);
    if (t !== 22) continue;
    hs = cat(hs, inner);
    while (hs.length >= 4 && hs.length >= 4 + ((hs[1] << 16) | (hs[2] << 8) | hs[3])) {
      const n = 4 + ((hs[1] << 16) | (hs[2] << 8) | hs[3]);
      transcript.push(hs.slice(0, n));
      if (hs[0] === 20) finished = true;
      hs = hs.slice(n);
    }
  }
  const finHash = await sha256(cat(...transcript));
  const verify = await hmac(await expandLabel(cHs, 'finished', new Uint8Array(0), 32), finHash);
  pipe.send(bytes(20, 3, 3, 0, 1, 1));
  pipe.send(await cHsCipher.seal(22, cat(bytes(20, u24(32)), verify)));
  const master = await hmac(await expandLabel(hsSecret, 'derived', emptyHash, 32), zeros);
  const cAp = await Cipher.from(await expandLabel(master, 'c ap traffic', finHash, 32));
  const sAp = await Cipher.from(await expandLabel(master, 's ap traffic', finHash, 32));
  // Records are decrypted ahead: every complete record already received is handed to WebCrypto at
  // once (nonces are taken in order when each decrypt starts), so decryption runs in parallel with
  // the download instead of one awaited record at a time.
  const pending = [];
  let eof = false;
  const recordReady = () => {
    const h = pipe.peek(5);
    return h !== null && pipe.have() >= 5 + ((h[3] << 8) | h[4]);
  };
  const fill = async () => {
    while (!eof && pending.length < 64 && (!pending.length || recordReady())) {
      const r = await readRecord(pipe);
      if (!r) { eof = true; break; }
      if (r.type !== 23) continue;
      const p = sAp.open(r.head, r.body);
      p.catch(() => {}); // a record left behind (the body ended earlier) mustn't be an unhandled rejection
      pending.push(p);
    }
  };
  return {
    write: async (data) => { for (let i = 0; i < data.length; i += 16384) pipe.send(await cAp.seal(23, data.subarray(i, i + 16384))); },
    async read() {
      for (;;) {
        await fill();
        if (!pending.length) return null;
        const [t, inner] = await pending.shift();
        if (t === 23) return inner;
        if (t === 21) { eof = true; pending.length = 0; return null; } // close_notify
      }
    },
  };
}

const CRLF2 = [13, 10, 13, 10];
const findHeaderEnd = (b) => {
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i;
  return -1;
};
function dechunk(b) {
  const parts = [];
  for (let i = 0; i < b.length;) {
    let j = i;
    while (j < b.length - 1 && !(b[j] === 13 && b[j + 1] === 10)) j++;
    const size = parseInt(new TextDecoder().decode(b.subarray(i, j)).split(';')[0].trim(), 16);
    if (!size) break;
    i = j + 2;
    parts.push(b.subarray(i, i + size));
    i += size + 2;
  }
  return cat(...parts);
}

// Ask for gzip where the browser can undo it: GitHub's file servers send proxyfox.html (Base64,
// 87 MB) as about 65 MB of gzip, a quarter less through the relay.
const GZIP = typeof DecompressionStream === 'function';
// Undoes gzip as the data arrives, so it overlaps the download instead of following it.
function gunzipper() {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  const out = new Response(ds.readable).arrayBuffer();
  out.catch(() => {});
  return {
    push: (c) => { w.write(c).catch(() => {}); },
    end: async () => { await w.close(); return new Uint8Array(await out); },
    abort: () => { w.abort().catch(() => {}); },
  };
}

// GET an https:// URL through `relay`. Resolves to { status, body: Uint8Array }; progress(got, total)
// is told as the body arrives (bytes on the wire: compressed, when the server compressed it).
// Follows redirects; a body shorter than its Content-Length fails.
// opts.signal cancels it; opts.onConnect() is called once the TLS handshake with the site is done.
export async function httpsGet(relay, href, progress, opts = {}, redirects = 5) {
  const url = new URL(href);
  const pipe = await wispOpen(relay, url.hostname, Number(url.port) || 443, opts.signal);
  let unzip = null;
  try {
    const tls = await tlsConnect(pipe, url.hostname);
    if (opts.signal?.aborted) throw new Error(`${relay}: cancelled`);
    pipe.connected();
    opts.onConnect?.();
    await tls.write(enc.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: Mozilla/5.0\r\n` +
      `Accept: */*\r\nAccept-Encoding: ${GZIP ? 'gzip' : 'identity'}\r\n\r\n`));
    let head = null, start = new Uint8Array(0), headers = {}, status = 0, total = 0, got = 0;
    const parts = [];
    for (let c; (c = await tls.read()) !== null;) {
      if (!head) {
        start = cat(start, c);
        const end = findHeaderEnd(start);
        if (end < 0) continue;
        head = new TextDecoder().decode(start.subarray(0, end)).split('\r\n');
        status = parseInt(head[0].split(' ')[1], 10);
        for (const line of head.slice(1)) {
          const k = line.indexOf(':');
          if (k > 0) headers[line.slice(0, k).trim().toLowerCase()] = line.slice(k + 1).trim();
        }
        total = Number(headers['content-length']) || 0;
        // Plain (not chunked) gzip: undone while it downloads. Chunked gzip is undone at the end.
        if (GZIP && /gzip/.test(headers['content-encoding'] || '') && !headers['transfer-encoding']) unzip = gunzipper();
        c = start.subarray(end + CRLF2.length);
      }
      if (unzip) unzip.push(c); else parts.push(c);
      got += c.length;
      progress?.(got, total);
      // The whole body is here: done, without waiting for the server to close (some relays drop
      // data still on its way when the website closes its end first).
      if (total && got >= total) break;
      if (!total && /chunked/.test(headers['transfer-encoding'] || '') && c.length >= 5 &&
        c[c.length - 5] === 48 && c[c.length - 4] === 13 && c[c.length - 3] === 10 && c[c.length - 2] === 13 && c[c.length - 1] === 10) break;
      if (!total && !headers['transfer-encoding'] && status !== 200) break; // a redirect without a body
    }
    if (!head) throw new Error('no HTTP answer');
    if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
      if (redirects <= 0) throw new Error('too many redirects');
      return httpsGet(relay, new URL(headers.location, url).href, progress, opts, redirects - 1);
    }
    if (opts.signal?.aborted) throw new Error(`${relay}: cancelled`);
    const chunked = (headers['transfer-encoding'] || '').includes('chunked');
    if (!chunked && total && got !== total) throw new Error(`got ${got} of ${total} bytes`);
    if (unzip) { const body = await unzip.end(); unzip = null; return { status, body }; }
    let body = parts.length === 1 ? parts[0] : cat(...parts);
    if (chunked) body = dechunk(body);
    if (/gzip/.test(headers['content-encoding'] || '')) {
      const z = gunzipper();
      z.push(body);
      body = await z.end();
    }
    return { status, body };
  } finally {
    unzip?.abort();
    pipe.close();
  }
}
