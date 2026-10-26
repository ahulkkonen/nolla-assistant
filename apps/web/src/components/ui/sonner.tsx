import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useMobile } from '@/media';
import { useStore } from '@/store';

/**
 * Brief 7.5: 360 wide, radius 12, popover with border and shadow; desktop bottom-right 16 from
 * the edges; phone bottom-center above the composer (`--toast-bottom`, set by the composer).
 */
const Toaster = ({ ...props }: ToasterProps) => {
  // The app theme, not next-themes (shadcn's default): 'system' | 'light' | 'dark'.
  const theme = useStore((s) => s.theme);
  const mobile = useMobile();
  const bottom = { bottom: 'var(--toast-bottom)' };

  return (
    <Sonner
      theme={theme}
      position={mobile ? 'bottom-center' : 'bottom-right'}
      offset={mobile ? bottom : 16}
      mobileOffset={bottom}
      duration={4000}
      customAriaLabel="Ilmoitukset"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-info" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--width': '360px',
          // Errors' close button on the right corner, not over the icon.
          '--toast-close-button-start': 'unset',
          '--toast-close-button-end': '0',
          '--toast-close-button-transform': 'translate(35%, -35%)',
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: 'Sulje',
        classNames: {
          toast: 'font-sans shadow-md!',
          // Phones: a 44 px close button inside the error toast at the right, not a corner dot.
          error: 'max-md:pr-14!',
          closeButton:
            'max-md:top-1/2! max-md:right-1! max-md:left-auto! max-md:size-11! max-md:-translate-y-1/2! max-md:transform-none! max-md:rounded-md! max-md:border-0! max-md:bg-transparent!',
          title: 'text-ui! font-medium!',
          description: 'text-meta! text-muted-foreground!',
          actionButton: 'h-8! rounded-md! border! border-border! bg-transparent! text-foreground!',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
