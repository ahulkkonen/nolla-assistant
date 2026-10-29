import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { touch } from '../media.ts';

type TipProps = {
  label: ReactNode;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Gap to the trigger; 4 px by default. */
  sideOffset?: number;
  /** The text screen readers get instead of `label` (a label with layout elements). */
  ariaLabel?: string;
  className?: string;
  /** Controlled: `false` keeps it shut (e.g. while recording), `true` shows a hint. */
  open?: boolean;
};

/** The last key moved focus (Tab, an arrow key): a focus that opens a tooltip. */
let focusKey = false;
globalThis.addEventListener?.('keydown', (e) => (focusKey = /^(Tab|Arrow)/.test(e.key)), true);
globalThis.addEventListener?.('pointerdown', () => (focusKey = false), true);

/** Kit tooltip around one trigger element; none on touch screens (brief 7.5). */
export function Tip({
  label,
  children,
  side,
  align,
  sideOffset = 4,
  ariaLabel,
  className,
  open,
}: TipProps) {
  if (touch && open === undefined) return children;
  return (
    <Tooltip {...(open === undefined ? {} : { open })}>
      <TooltipTrigger
        asChild
        // Phase-22 decision 6: focus that a dialog, sheet or menu moves (on open, back on close)
        // opens no tooltip, so the next Esc reaches the dialog and not the tooltip.
        onFocus={(e) => !focusKey && e.preventDefault()}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        sideOffset={sideOffset}
        collisionPadding={8}
        {...(side ? { side } : {})}
        {...(align ? { align } : {})}
        {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
        {...(className ? { className } : {})}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

type Props = ComponentProps<'button'> & {
  label: string;
  variant?: 'ghost' | 'primary';
  tipSide?: TipProps['side'];
  /** The tooltip instead of `label`: why an `aria-disabled` button waits. */
  tip?: string | undefined;
};

/** An icon-only button: a Finnish `aria-label` and a desktop tooltip with the same text. */
export function IconButton({ label, variant = 'ghost', tipSide, tip, className, ...rest }: Props) {
  return (
    <Tip label={tip ?? label} {...(tipSide ? { side: tipSide } : {})}>
      <Button
        type="button"
        size="icon"
        variant={variant === 'primary' ? 'default' : 'ghost'}
        aria-label={label}
        className={cn(
          variant === 'ghost' && 'text-muted-foreground hover:text-foreground',
          rest['aria-disabled'] && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          rest['aria-disabled'] && variant === 'ghost' && 'hover:text-muted-foreground',
          className,
        )}
        {...rest}
      />
    </Tip>
  );
}
