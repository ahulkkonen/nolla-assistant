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
  /** The text screen readers get instead of `label` (a label with layout elements). */
  ariaLabel?: string;
  className?: string;
  /** Controlled: `false` keeps it shut (e.g. while recording), `true` shows a hint. */
  open?: boolean;
};

/** Kit tooltip around one trigger element; none on touch screens (brief 7.5). */
export function Tip({ label, children, side, align, ariaLabel, className, open }: TipProps) {
  if (touch && open === undefined) return children;
  return (
    <Tooltip {...(open === undefined ? {} : { open })}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        sideOffset={4}
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
};

/** An icon-only button: a Finnish `aria-label` and a desktop tooltip with the same text. */
export function IconButton({ label, variant = 'ghost', tipSide, className, ...rest }: Props) {
  return (
    <Tip label={label} {...(tipSide ? { side: tipSide } : {})}>
      <Button
        type="button"
        size="icon"
        variant={variant === 'primary' ? 'default' : 'ghost'}
        aria-label={label}
        className={cn(
          variant === 'ghost' && 'text-muted-foreground hover:text-foreground',
          rest['aria-disabled'] && 'cursor-not-allowed opacity-50 hover:bg-transparent',
          className,
        )}
        {...rest}
      />
    </Tip>
  );
}
