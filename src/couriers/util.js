function toLocalPkPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('92')) digits = `0${digits.slice(2)}`;
  if (!digits.startsWith('0') && digits.length === 10) digits = `0${digits}`;
  return digits;
}

function piecesFromOrder(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  return items.reduce((sum, i) => sum + (Number(i.qty) || 1), 0) || 1;
}

function itemsText(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return 'Order';
  return items.map((i) => `${i.name || 'Item'} x${i.qty || 1}`).join(', ');
}

function pickTracking(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const dist = payload.dist || payload.data || payload.result || payload.Response || payload;
  return (
    dist.trackingNumber ||
    dist.TrackingNumber ||
    dist.track_number ||
    dist.trackNumber ||
    dist.cn ||
    dist.CN ||
    dist.cnNumber ||
    dist.consignmentNo ||
    dist.consignmentno ||
    dist.airwayBill ||
    dist.orderId ||
    payload.trackingNumber ||
    payload.track_number ||
    null
  );
}

function codCollectAmount(order) {
  const total = Number(order?.totalAmount) || 0;
  const paid = Number(order?.paidAmount) || 0;
  const due = total - paid;
  return Math.max(0, Math.round(due));
}

module.exports = { toLocalPkPhone, piecesFromOrder, itemsText, pickTracking, codCollectAmount };
