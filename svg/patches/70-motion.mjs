// CPU: "Reduce motion", on by default.
//
// Most sites (Discord's included) honor the reduced-motion preference: with it they stop their
// decorative animations. In Proxyfox every animation frame is laid out and painted by Firefox's
// single busy engine thread, so an animated page keeps the CPU busy even when nothing happens.
// Measured on discord.com (1366x768, same machine, A/B twice each):
//   at rest:     2.55 / 2.34 CPU cores -> 0.55 / 0.62 (-75%)
//   fast scroll: 26.4 / 21.3 fps at 3.0-3.2 cores -> 36.3 / 35.4 fps at 1.9 cores
//                (frame gap p50 67-80 ms -> 44-47 ms, worst 191-215 ms -> 116-132 ms)
// Options > "Reduce motion" turns it off; the change applies at once (it is a live Firefox pref).
export default [
  {
    name: 'Options: the "Reduce motion" checkbox',
    target: 'page',
    from: '<label class="toggle"><input type="checkbox" id="opt-quiet">',
    to: '<label class="toggle"><input type="checkbox" id="opt-motion"><span><b>Reduce motion (less CPU)</b><small>Asks sites to skip decorative animations, as the reduce-motion setting of your system would: animated pages (like Discord\'s home page) stop using the CPU while you only look at them, and scrolling gets smoother on slower computers. On by default; turn it off to see sites\' animations. Applies at once.</small></span></label>\n          <label class="toggle"><input type="checkbox" id="opt-quiet">',
  },
  {
    name: 'Options: the checkbox element',
    target: 'app',
    from: 'var optQuiet = $("opt-quiet");',
    to: 'var optQuiet = $("opt-quiet");\nvar optMotion = $("opt-motion");',
  },
  {
    name: 'Options: saved with the others',
    target: 'app',
    from: 'quiet: optQuiet.checked, jsJit:',
    to: 'quiet: optQuiet.checked, motion: optMotion.checked, jsJit:',
  },
  {
    name: 'Options: on by default; a change reaches a running Firefox at once',
    target: 'app',
    from: '  optQuiet.checked = saved.quiet ?? true;',
    to: `  optQuiet.checked = saved.quiet ?? true;
  optMotion.checked = saved.motion ?? true;
  optMotion.addEventListener("change", () => {
    const v = optMotion.checked ? 1 : 0;
    globalThis.gecko?.evalChrome?.(\`Services.prefs.setIntPref("ui.prefersReducedMotion", \${v}); "ok"\`)?.catch?.(() => {});
  });`,
  },
  {
    name: 'Launch: the pref, when the option is on',
    target: 'app',
    from: '  if (opts.quiet) {\n    addVirtualFile(decoded.chromeIndex, QUIET_PREFS_PATH, QUIET_PREFS);',
    to: `  if (opts.motion !== false) {
    addVirtualFile(decoded.chromeIndex, "browser/defaults/preferences/a-firefox-html-motion.js", '// Added by proxyfox.html: Options > Reduce motion.\\npref("ui.prefersReducedMotion", 1);\\n');
    console.log("[proxyfox.html] reduce motion: on (Options)");
  }
  if (opts.quiet) {
    addVirtualFile(decoded.chromeIndex, QUIET_PREFS_PATH, QUIET_PREFS);`,
  },
];
