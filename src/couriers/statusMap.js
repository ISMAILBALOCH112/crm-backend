function firstString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function mapCourierStatus(rawText, extra = '') {
  const label = firstString(rawText, extra) || 'Unknown';
  const t = `${rawText || ''} ${extra || ''}`.toLowerCase();

  const delivered =
    /\bdelivered\b/.test(t) ||
    /\bshipment delivered\b/.test(t) ||
    /\bdelivery done\b/.test(t) ||
    t.includes('0005');
  const undelivered = /undelivered|not delivered|failed delivery/.test(t);
  if (delivered && !undelivered) {
    return { mappedStatus: 'delivered', courierStatus: label };
  }

  const returned =
    /\breturn(ed|ing)?\b/.test(t) ||
    /\brto\b/.test(t) ||
    /\breversal\b/.test(t) ||
    t.includes('out for return') ||
    t.includes('0002') ||
    t.includes('0006') ||
    t.includes('0007');
  if (returned) {
    return { mappedStatus: 'returned', courierStatus: label };
  }

  return { mappedStatus: 'shipped', courierStatus: label };
}

module.exports = { firstString, mapCourierStatus };
