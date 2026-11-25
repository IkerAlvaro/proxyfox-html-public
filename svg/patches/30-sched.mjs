// Threads, scheduling, timers and input latency (see scratchpad/reports/sched.md).
export default [
  {
    name: 'input: queued wheel events merge into one command (sum of the deltas)',
    target: 'app',
    from: '      if (item.op === OP_MOUSE && item.evType === 0 && last && last.op === OP_MOUSE && last.evType === 0) {\n        last.resolve?.(null);\n        this.queue[at - 1] = item;\n      } else {',
    to: '      if (item.op === OP_MOUSE && item.evType === 0 && last && last.op === OP_MOUSE && last.evType === 0) {\n        last.resolve?.(null);\n        this.queue[at - 1] = item;\n      } else if (item.op === OP_WHEEL && last && last.op === OP_WHEEL && last.modifiers === item.modifiers && new URLSearchParams(location.search).get("wheelmerge") !== "0") {\n        last.deltaX += item.deltaX;\n        last.deltaY += item.deltaY;\n        last.x = item.x;\n        last.y = item.y;\n        const prev = last.resolve;\n        last.resolve = (v) => {\n          prev?.(v);\n          resolve(v);\n        };\n      } else {',
  },
];
