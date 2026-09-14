let activeToken = null;
const context = new (require('async_hooks').AsyncLocalStorage)();
function runWithCancelToken(token, work) { return context.run(token, work); }
function createScopedToken(label) { return { label, cancelled: false, children: new Set(), abortController: new AbortController() }; }

function createCancelToken(label = "operation") {
  if (context.getStore()) return context.getStore();
  activeToken = {
    label,
    cancelled: false,
    children: new Set()
  };
  return activeToken;
}

function getCancelToken() {
  return context.getStore() || activeToken;
}

function clearCancelToken(token = getCancelToken()) {
  if (!token || token !== activeToken) return;
  activeToken = null;
}

function cancelActiveOperation(reason = "User cancelled operation.") {
  return cancelToken(activeToken, reason);
}
function cancelToken(token, reason = "User cancelled operation.") {
  if (!token) return false;
  token.cancelled = true;
  token.reason = reason;
  try {
    token.abortController?.abort(reason);
  } catch (_error) {}
  for (const child of token.children) {
    try {
      child.kill("SIGKILL");
    } catch (_error) {
      try {
        child.kill();
      } catch (_ignored) {}
    }
  }
  return true;
}

function throwIfCancelled(token = getCancelToken()) {
  if (token?.cancelled) {
    throw new Error(token.reason || "Đã dừng thao tác.");
  }
}

function trackChild(child, token = getCancelToken()) {
  if (!token || !child) return () => {};
  token.children.add(child);
  if (token.cancelled) {
    try {
      child.kill("SIGKILL");
    } catch (_error) {
      child.kill();
    }
  }
  return () => token.children.delete(child);
}

module.exports = {
  createCancelToken,
  getCancelToken,
  clearCancelToken,
  cancelActiveOperation,
  throwIfCancelled,
  trackChild,
  runWithCancelToken,
  createScopedToken,
  cancelToken
};
