import type { FxRate } from './index.ts';

/** Phase-13 decision 17: cost and token counts as the thread, the menu and the export show them. */

const money = (currency: 'EUR' | 'USD', digits: number) =>
  new Intl.NumberFormat('fi-FI', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const oneDecimal = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 1 });

/**
 * `usd` in euros at `rate` (EUR = USD / usdPerEur), or in dollars without a rate. `reply`: three
 * decimals below 0,10, "< 0,001" below that; otherwise two decimals, "< 0,01" below that. An
 * estimate gets "~".
 */
export function formatCost(
  usd: number,
  rate: FxRate | null,
  opts: { reply?: boolean; estimated?: boolean } = {},
): string {
  const value = rate ? usd / rate.usdPerEur : usd;
  const currency = rate ? 'EUR' : 'USD';
  const floor = opts.reply ? 0.001 : 0.01;
  const digits = opts.reply && value < 0.1 ? 3 : 2;
  const text =
    value > 0 && value < floor
      ? `< ${money(currency, opts.reply ? 3 : 2).format(floor)}`
      : money(currency, digits).format(value);
  return opts.estimated ? `~${text}` : text;
}

/** "1 tokeni", "640 tokenia", "3,4 k tokenia", "18 k tokenia", "1,2 M tokenia". */
export function formatTokens(n: number): string {
  if (n === 1) return '1 tokeni';
  if (n < 1000) return `${n} tokenia`;
  if (n < 10_000) return `${oneDecimal.format(n / 1000)} k tokenia`;
  if (n < 999_500) return `${Math.round(n / 1000)} k tokenia`;
  return `${oneDecimal.format(n / 1_000_000)} M tokenia`;
}
