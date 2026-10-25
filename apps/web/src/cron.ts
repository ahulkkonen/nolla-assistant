const DAYS = ['su', 'ma', 'ti', 'ke', 'to', 'pe', 'la', 'su'];
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);

/** `1-5` → `ma–pe`, `1,3` → `ma, ke`; null for steps or names. */
function days(dow: string) {
  const parts = dow.split(',').map((p) => {
    const [a, b] = p.split('-').map(num);
    if (a == null || a > 7 || (p.includes('-') && (b == null || b > 7))) return null;
    return b == null ? DAYS[a] : `${DAYS[a]}–${DAYS[b]}`;
  });
  return parts.every(Boolean) ? parts.join(', ') : null;
}

/**
 * Common cron shapes in Finnish ("ma–pe klo 7.00", "1.1. klo 3.00", "joka minuutti"). Anything
 * else comes back unchanged; the screen shows the raw expression in a tooltip either way.
 */
export function cronText(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length === 6) f.shift(); // seconds first
  if (f.length !== 5) return cron;
  const [m, h, dom, mon, dow] = f as [string, string, string, string, string];
  if (f.every((x) => x === '*')) return 'joka minuutti';
  const [mm, hh] = [num(m), num(h)];
  if (mm == null || hh == null || mm > 59 || hh > 23) return cron;
  const at = `klo ${hh}.${String(mm).padStart(2, '0')}`;
  const [d, mo] = [num(dom), num(mon)];
  if (dom === '*' && mon === '*') {
    if (dow === '*') return `joka päivä ${at}`;
    const ds = days(dow);
    return ds ? `${ds} ${at}` : cron;
  }
  if (dow !== '*') return cron;
  if (d != null && mo != null) return `${d}.${mo}. ${at}`;
  if (d != null && mon === '*') return `kuun ${d}. päivä ${at}`;
  return cron;
}
