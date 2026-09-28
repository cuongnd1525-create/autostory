function isRateLimit(error) {
  return error?.httpStatus === 429 || error?.kind === 'PROVIDER_RATE_LIMIT'
    || /request failed \(429\)|RESOURCE_EXHAUSTED|Resource exhausted/i.test(error?.message || '');
}
function retryDelay(error, attempt, random = Math.random) {
  if (!isRateLimit(error) || attempt >= 2) return null;
  const advertised = Number(error.retryAfterMs) || 0;
  // Do not retry earlier than the provider requests, or wait indefinitely.
  if (advertised > 90000) return null;
  return Math.max(advertised, 15000 * 2 ** attempt + Math.floor(random() * 3000));
}
function exhausted(error, stage) {
  error.kind = 'PROVIDER_RATE_LIMIT'; error.httpStatus = 429; error.stage = stage;
  if (!error.providerMessage) {
    error.providerMessage = error.message;
    error.message = `Vertex tạm hết tài nguyên phục vụ (429) tại ${stage}. Đã giữ kết quả các bước hoàn tất; hãy thử lại sau. Đây không phải kết luận hook/kịch bản không đạt.`;
  }
  return error;
}
module.exports = { isRateLimit, retryDelay, exhausted };
