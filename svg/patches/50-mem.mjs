// Memory / storage / startup / media patches (area "mem"). See reports/mem.md.
export default [
  {
    // Every fsync of an OPFS file (sqlite commits: IndexedDB, localStorage, places, cookies;
    // prefs.js; the session file) was a synchronous round trip to the OPFS thread plus a real
    // disk flush (accessHandle.flush(), 5-60 ms), and the engine thread waits for it. The data
    // is already in the OS by the write() before it, so the flush only matters for a power
    // cut or an OS crash: do it 1.5 s later, in one go, and let the engine go on at once. A
    // handle that is closed first is flushed when it closes, as before.
    name: 'opfs: fsync is answered at once and flushed in the background',
    target: 'glue',
    from: '  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);\n  try {\n    await accessHandle.flush();\n  } catch {',
    to: '  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);\n  try {\n    var lazy = globalThis.__pfLazyFlush || (globalThis.__pfLazyFlush = new Map());\n    lazy.set(accessID, accessHandle);\n    if (!globalThis.__pfLazyTimer) globalThis.__pfLazyTimer = setTimeout(() => {\n      globalThis.__pfLazyTimer = 0;\n      for (var [id, h] of lazy) { lazy.delete(id); try { var p = h.flush(); if (p && p.catch) p.catch(() => {}); } catch (e) {} }\n    }, 1500);\n  } catch {',
  },
  {
    name: 'opfs: a handle with a pending flush is flushed when it closes',
    target: 'glue',
    from: '  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);\n  try {\n    await accessHandle.close();',
    to: '  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);\n  try {\n    if (globalThis.__pfLazyFlush && globalThis.__pfLazyFlush.get(accessID) === accessHandle) {\n      globalThis.__pfLazyFlush.delete(accessID);\n      try { await accessHandle.flush(); } catch (e) {}\n    }\n    await accessHandle.close();',
  },
];
