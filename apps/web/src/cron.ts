import { cronToSchedule } from '@nolla/protocol';

const DAYS = ['su', 'ma', 'ti', 'ke', 'to', 'pe', 'la', 'su'];
const clock = (h: number, m: number) => `klo ${h}.${String(m).padStart(2, '0')}`;
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
  const at = clock(hh, mm);
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

/** The editor's presets in words (phase-15 decision 8): "Arkisin klo 7.30"; else `cronText`. */
export function scheduleText(cron: string): string {
  const s = cronToSchedule(cron);
  if (s.kind === 'custom') return cronText(cron);
  const at = clock(s.hour, s.minute);
  if (s.kind === 'weekly') return `Viikoittain ${DAYS[s.day]} ${at}`;
  return `${s.kind === 'daily' ? 'Päivittäin' : 'Arkisin'} ${at}`;
}

/** A run time in local time: "ma 27.10. klo 7.30". */
export function runText(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}. ${clock(d.getHours(), d.getMinutes())}`;
}
