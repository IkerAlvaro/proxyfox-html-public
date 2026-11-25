// Zero-delay hand-offs in the engine's JavaScript: a MessageChannel turn instead of setTimeout(0).
// Browsers clamp a setTimeout(0) to about 4 ms once timers are nested (the engine thread always is, it
// runs its wasm from timer and message callbacks); in Chromium 158 a nested setTimeout(0) step costs
// ~3.6 ms, a MessageChannel turn ~0.005 ms (reports/sched.md). Two places hand work to themselves:
//  - the thread's own mailbox (__emscripten_notify_mailbox_postmessage to the current thread), which
//    carries tasks the engine dispatches to itself;
//  - the SwapBuffers yield in GPU mode (_gl_present_yield).
// Same order and count of callbacks as before: one message per call.
export default [
  {
    name: 'engine thread: its own mailbox is checked in a MessageChannel turn, not setTimeout(0)',
    target: 'glue',
    from: `function __emscripten_notify_mailbox_postmessage(targetThread, currThreadId) {
  targetThread >>>= 0;
  currThreadId >>>= 0;
  if (targetThread == currThreadId) {
    setTimeout(checkMailbox);`,
    to: `var __selfMailboxPort = null;
function __emscripten_notify_mailbox_postmessage(targetThread, currThreadId) {
  targetThread >>>= 0;
  currThreadId >>>= 0;
  if (targetThread == currThreadId) {
    if (!__selfMailboxPort) {
      var __mc = new MessageChannel();
      __mc.port1.onmessage = function() { checkMailbox(); };
      __selfMailboxPort = __mc.port2;
    }
    __selfMailboxPort.postMessage(0);`,
  },
  {
    name: 'GPU mode: the SwapBuffers yield is a MessageChannel turn, not setTimeout(0)',
    target: 'glue',
    from: `function _gl_present_yield() {
  return new Promise(function(resolve) {
    setTimeout(resolve, 0);
  });
}`,
    to: `var __presentYield = null;
function _gl_present_yield() {
  if (!__presentYield) {
    var ch = new MessageChannel(), waiting = [];
    ch.port1.onmessage = function() { var w = waiting; waiting = []; for (var i = 0; i < w.length; i++) w[i](); };
    __presentYield = function(resolve) { if (!waiting.length) ch.port2.postMessage(0); waiting.push(resolve); };
  }
  return new Promise(__presentYield);
}`,
  },
];
