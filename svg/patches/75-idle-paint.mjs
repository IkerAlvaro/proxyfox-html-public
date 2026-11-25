// CPU: the software-mode paint loop stops racing after a one-off change.
//
// After any change on screen the loop pulled frames at full speed (one per animation frame) for
// 250 ms, each pull rendering the whole page and converting every pixel. A blinking text cursor
// changes the screen every ~500 ms, so half the time Proxyfox rendered ~60 frames a second for a
// one-pixel caret (measured on about:blank at rest: the page thread spent 1.2 s of every 13.6 s
// converting unchanged frames). Now the loop keeps full speed only while frames keep changing
// (an animation) or the person interacts; a change that doesn't repeat backs off at once.
// GPU mode has its own loop (a 250 ms poll) and is unaffected.
export default [
  {
    name: 'software paint loop: full speed only while frames keep changing',
    target: 'app',
    from: `          const before = this.coopFrameHash;
          await this.run({ op: OP_PAINT });
          if (!this.mod || this.destroyed) return;
          if (this.coopFrameHash !== before) lastChange = performance.now();
        }
        const now = performance.now();
        const busy = now - lastChange < 250 || now - this.coopLastInput < 1500;`,
    to: `          const before = this.coopFrameHash;
          await this.run({ op: OP_PAINT });
          if (!this.mod || this.destroyed) return;
          changedNow = this.coopFrameHash !== before;
          if (changedNow) lastChange = performance.now();
        } else changedNow = false;
        const now = performance.now();
        // proxyfox fork: a change that doesn't repeat on the next pull (a caret blink) backs off.
        const busy = (changedNow && now - lastChange < 250) || now - this.coopLastInput < 1500;`,
  },
  {
    name: 'software paint loop: remembers whether the last pull changed the frame',
    target: 'app',
    from: '      let backoff = 0, lastChange = 0, lastPull2 = 0;',
    to: '      let backoff = 0, lastChange = 0, lastPull2 = 0, changedNow = false;',
  },
];
