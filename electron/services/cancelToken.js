let activeToken = null;

function createCancelToken(label = "operation") {
  activeToken = {
    label,
    cancelled: false,
    children: new Set()
  };
  return activeToken;
}

function getCancelToken() {
  return activeToken;
}

function clearCancelToken(token = activeToken) {
  if (!token || token !== activeToken) return;
  activeToken = null;
}

function cancelActiveOperation(reason = "User cancelled operation.") {
  const token = activeToken;
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

function throwIfCancelled(token = activeToken) {
  if (token?.cancelled) {
    throw new Error(token.reason || "Đã dừng thao tác.");
  }
}

function trackChild(child, token = activeToken) {
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
  trackChild
};
