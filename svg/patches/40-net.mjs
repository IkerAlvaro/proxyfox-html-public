// Network path: the WISP client in the app, the relay choice, and the glue's socket layer.
// (Measurements: .../scratchpad/reports/net.md)
export default [
  // ---- wisp-js client: per-packet copies -------------------------------------------------------
  // Firefox, its TLS and its JavaScript all run on the page's one thread, so every copy a packet
  // takes is time the engine does not run. A DATA packet to the relay was copied out of the wasm
  // heap, wrapped in a WispBuffer, a WispPacket and a DataPayload, then copied again by
  // WispBuffer.concat (header + payload). It is now built once, straight from the heap.
  {
    name: 'wisp client: DATA packets are built once (send, send_heap)',
    target: 'app',
    from: `  send(data) {
    if (this.buffer_size > 0 || !this.open || this.stream_type === stream_types.UDP) {
      let packet = new WispPacket({
        type: packet_types.DATA,
        stream_id: this.stream_id,
        payload: new DataPayload({
          data: new WispBuffer(data)
        })
      });
      this.ws.send(packet.serialize().bytes);
      this.buffer_size--;
    } else {
      this.send_buffer.push(data);
    }
  }`,
    to: `  send(data) {
    if (this.buffer_size > 0 || !this.open || this.stream_type === stream_types.UDP) {
      const id = this.stream_id, out = new Uint8Array(5 + data.length);
      out[0] = 2;
      out[1] = id & 255;
      out[2] = id >>> 8 & 255;
      out[3] = id >>> 16 & 255;
      out[4] = id >>> 24 & 255;
      out.set(data, 5);
      this.ws.send(out);
      this.buffer_size--;
    } else {
      this.send_buffer.push(data);
    }
  }
  // The engine's send: the payload goes from the wasm heap into the packet in one copy.
  send_heap(heap, ptr, len) {
    if (this.buffer_size > 0 || !this.open || this.stream_type === stream_types.UDP) {
      const id = this.stream_id, out = new Uint8Array(5 + len);
      out[0] = 2;
      out[1] = id & 255;
      out[2] = id >>> 8 & 255;
      out[3] = id >>> 16 & 255;
      out[4] = id >>> 24 & 255;
      out.set(heap.subarray(ptr, ptr + len), 5);
      this.ws.send(out);
      this.buffer_size--;
    } else {
      this.send_buffer.push(heap.slice(ptr, ptr + len));
    }
  }`
  },
  // A DATA packet from the relay went through WispBuffer, WispPacket.parse_all (which slices, i.e.
  // copies, the payload) and was then copied into the wasm heap by the engine. The payload is now
  // a view of the WebSocket message: the engine copies it into the heap at once.
  {
    name: 'wisp client: DATA packets from the relay are not copied',
    target: 'app',
    from: `  on_ws_msg(event) {
    let buffer = new WispBuffer(new Uint8Array(event.data));`,
    to: `  on_ws_msg(event) {
    {
      const d = event.data;
      if (d instanceof ArrayBuffer && d.byteLength > 5) {
        const u = new Uint8Array(d);
        if (u[0] === 2) {
          const fast = this.active_streams[(u[1] | u[2] << 8 | u[3] << 16 | u[4] << 24) >>> 0];
          if (fast) {
            fast.onmessage(u.subarray(5));
            return;
          }
        }
      }
    }
    let buffer = new WispBuffer(new Uint8Array(event.data));`
  },
  {
    // The engine's send goes through send_heap when the stream has it (the app's own warm-up and
    // prompt streams don't). The next lines are the old copy-and-send, still there for them.
    name: 'glue: relay sends take one copy',
    target: 'glue',
    from: `    if (!stream) return;
    // Copy out of the heap: wisp-js may buffer the reference (per-stream flow`,
    to: `    if (!stream) return;
    if (stream.send_heap) {
      stream.send_heap((growMemViews(), HEAPU8), ptr >>> 0, len >>> 0);
      return;
    }
    // Copy out of the heap: wisp-js may buffer the reference (per-stream flow`
  },

  // ---- relay choice ------------------------------------------------------------------------
  // The relays were tried one after the other (3 s each when one doesn't answer), the first that
  // opened won whatever its speed. Now up to six are tried at once: the first to answer opens the
  // choice, 150 ms later the best one is taken, scored by how fast it opened plus 60 ms for each
  // place down the list (so the list's order still counts). A dead relay at the top costs nothing.
  // ?relayrace=0 goes back to one after the other.
  {
    name: 'relay: the candidates are tried together, the fastest is used',
    target: 'app',
    from: 'async function pickRelay(cands) {\n',
    to: `function probeWispTimed(url, sockets) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      return resolve({ ok: false, why: e.message });
    }
    sockets.push(ws);
    const t = setTimeout(() => resolve({ ok: false, why: "no answer within 3 s" }), 3e3);
    ws.onopen = () => {
      clearTimeout(t);
      resolve({ ok: true, ms: performance.now() - t0 });
    };
    ws.onerror = () => {
      clearTimeout(t);
      resolve({ ok: false, why: "connection failed" });
    };
  });
}
async function pickRelayRace(cands) {
  const top = cands.slice(0, 6), sockets = [], won = [];
  let firstAt = 0, wake;
  const kick = new Promise((r) => wake = r);
  const runs = top.map((u, i) => probeWispTimed(u, sockets).then((r) => {
    if (r.ok) {
      won.push({ u, i, score: r.ms + 60 * i });
      if (!firstAt) {
        firstAt = performance.now();
        setTimeout(wake, 150);
      }
    } else console.warn(\`[proxyfox.html] relay: \${u} didn't connect (\${r.why})\`);
  }));
  await Promise.race([kick, Promise.all(runs)]);
  for (const ws of sockets) {
    try {
      ws.onopen = ws.onerror = null;
      ws.close();
    } catch {
    }
  }
  if (!won.length) return null;
  won.sort((a, b) => a.score - b.score);
  console.log(\`[proxyfox.html] relay race: \${won.map((w) => \`\${w.u} \${Math.round(w.score - 60 * w.i)} ms\`).join(", ")}; using \${won[0].u}\`);
  return { url: won[0].u, state: "ok" };
}
async function pickRelay(cands) {
  if (navigator.onLine && cands.length > 1 && new URLSearchParams(location.search).get("relayrace") !== "0") {
    const r = await pickRelayRace(cands);
    if (r) return r;
    if (cands.length <= 6) return { url: cands[0] || "", state: navigator.onLine ? "none" : "offline" };
    return pickRelaySeq(cands.slice(6));
  }
  return pickRelaySeq(cands);
}
async function pickRelaySeq(cands) {
`
  },

  // ---- a relay that dies while Firefox runs -----------------------------------------------------
  // retryRelay (try the list again, move to another relay) only ran at startup and when the
  // browser came back online. A relay that stopped answering later left every site failing for
  // the rest of the session, however many relays the list holds. The engine now says when a
  // relay connection drops or fails (not when the page closed it on purpose); the page checks the
  // relay in use and moves to another one only if it really doesn't answer.
  {
    name: 'glue: a relay connection that drops is reported to the page',
    target: 'glue',
    from: `    client.onclose = function() {
      teardown(0);
    };
    client.onerror = function() {
      teardown(111);
    };`,
    to: `    var reportFail = function(deliberate) {
      if (deliberate) return;
      try { if (globalThis.__proxyfoxRelayFailed) globalThis.__proxyfoxRelayFailed(url); } catch (e) {}
    };
    client.onclose = function() {
      var deliberate = conn.dead;
      teardown(0);
      reportFail(deliberate);
    };
    client.onerror = function() {
      var deliberate = conn.dead;
      teardown(111);
      reportFail(deliberate);
    };`
  },
  {
    name: 'relay: a relay that stopped answering is replaced',
    target: 'app',
    from: 'addEventListener("online", () => void retryRelay());\n',
    to: `addEventListener("online", () => void retryRelay());
var relayCheckAt = 0;
globalThis.__proxyfoxRelayFailed = async () => {
  const now = performance.now();
  if (!relay.cands.length || relay.state !== "ok" || now - relayCheckAt < 5e3 || !navigator.onLine) return;
  relayCheckAt = now;
  const r = await probeWisp(relay.url);
  if (r.ok) return;
  console.warn(\`[proxyfox.html] relay: \${relay.url} stopped answering (\${r.why}), looking for another\`);
  await retryRelay();
};
`
  },
];
