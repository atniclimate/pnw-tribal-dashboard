// @ts-nocheck
/**
 * The May 2026 gridpoint QPF aggregator, copied verbatim from site/classic/index.html (lines 2311 to 2395),
 * for the parity test. The only change: `todayKey` reads `now`, a parameter, instead of `new Date()`, so the
 * test controls the clock. It buckets days in the browser's zone, which is the defect the port fixes.
 */

export function parseIsoDuration(str) {
  const m = String(str || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d, h, mn, s] = m;
  return ((((+d || 0) * 24) + (+h || 0)) * 60 + (+mn || 0)) * 60_000 + (+s || 0) * 1000;
}

function parseValidTime(validTime) {
  const [startStr, durStr] = String(validTime || '').split('/');
  const start = new Date(startStr);
  if (isNaN(start.getTime())) return null;
  const durMs = parseIsoDuration(durStr);
  if (durMs == null) return null;
  return { start, end: new Date(start.getTime() + durMs) };
}

function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function aggregateGridpointDaily(props, now) {
  const qpfSeries = props.quantitativePrecipitation?.values || [];
  const qpfUom = props.quantitativePrecipitation?.uom || '';
  const popSeries = props.probabilityOfPrecipitation?.values || [];

  const days = new Map();
  const ensure = key => {
    let day = days.get(key);
    if (!day) { day = { mm: 0, prob: 0 }; days.set(key, day); }
    return day;
  };

  for (const entry of qpfSeries) {
    const interval = parseValidTime(entry.validTime);
    if (!interval || !Number.isFinite(entry.value)) continue;
    const totalMs = interval.end - interval.start;
    if (totalMs <= 0) {
      ensure(localDayKey(interval.start)).mm += entry.value;
      continue;
    }
    let cursor = new Date(interval.start);
    while (cursor < interval.end) {
      const endOfLocalDay = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
      const segEnd = endOfLocalDay < interval.end ? endOfLocalDay : interval.end;
      ensure(localDayKey(cursor)).mm += entry.value * ((segEnd - cursor) / totalMs);
      cursor = segEnd;
    }
  }

  for (const entry of popSeries) {
    const interval = parseValidTime(entry.validTime);
    if (!interval || !Number.isFinite(entry.value)) continue;
    let cursor = new Date(interval.start.getFullYear(), interval.start.getMonth(), interval.start.getDate());
    while (cursor < interval.end) {
      const day = ensure(localDayKey(cursor));
      if (entry.value > day.prob) day.prob = entry.value;
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
  }

  const mmToInches = qpfUom.includes('mm') ? 0.0393701 : 1;
  const todayKey = localDayKey(now);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([k]) => k >= todayKey)
    .slice(0, 7)
    .map(([key, val]) => {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      return {
        day: key === todayKey ? 'Today' : dayNames[date.getDay()],
        date: `${m}/${d}`,
        amount: val.mm * mmToInches,
        probability: Math.round(val.prob)
      };
    });
}
