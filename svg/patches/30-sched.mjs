// Threads, scheduling, timers and input latency (see scratchpad/reports/sched.md).
export default [
  {
    name: 'input: queued wheel events merge into one command (sum of the deltas)',
    target: 'app',
    from: '      if (item.op === OP_MOUSE && item.evType === 0 && last && last.op === OP_MOUSE && last.evType === 0) {\n        last.resolve?.(null);\n        this.queue[at - 1] = item;\n      } else {',
    to: '      if (item.op === OP_MOUSE && item.evType === 0 && last && last.op === OP_MOUSE && last.evType === 0) {\n        last.resolve?.(null);\n        this.queue[at - 1] = item;\n      } else if (item.op === OP_WHEEL && last && last.op === OP_WHEEL && last.modifiers === item.modifiers && new URLSearchParams(location.search).get("wheelmerge") !== "0") {\n        last.deltaX += item.deltaX;\n        last.deltaY += item.deltaY;\n        last.x = item.x;\n        last.y = item.y;\n        const prev = last.resolve;\n        last.resolve = (v) => {\n          prev?.(v);\n          resolve(v);\n        };\n      } else {',
  },
  {
    name: 'input: fractional wheel deltas are carried over, not truncated to 0',
    target: 'app',
    from: '      this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: e.deltaX * this.cssScale, deltaY: e.deltaY * this.cssScale, modifiers: this.mods(e) });\n      e.preventDefault();',
    to: '      const wx = this.wheelCarry.x + e.deltaX * this.cssScale, wy = this.wheelCarry.y + e.deltaY * this.cssScale;\n      const wix = Math.trunc(wx), wiy = Math.trunc(wy);\n      this.wheelCarry = { x: wx - wix, y: wy - wiy };\n      if (wix || wiy) this.run({ op: OP_WHEEL, x: p.x, y: p.y, deltaX: wix, deltaY: wiy, modifiers: this.mods(e) });\n      e.preventDefault();',
  },
  {
    name: 'input: wheel carry field',
    target: 'app',
    from: '  touchCarry = { x: 0, y: 0 };',
    to: '  touchCarry = { x: 0, y: 0 };\n  wheelCarry = { x: 0, y: 0 };',
  },
];
