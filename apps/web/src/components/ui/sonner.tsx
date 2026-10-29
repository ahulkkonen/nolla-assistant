import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  TriangleAlertIcon,
  XIcon,
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
      // Above the composer on every width while it is on screen (`--toast-bottom`), else 16 px.
      offset={mobile ? bottom : { bottom: 'var(--toast-bottom, 16px)', right: 16 }}
      mobileOffset={bottom}
      duration={4000}
      customAriaLabel="Ilmoitukset"
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4 text-success" />,
        info: <InfoIcon className="size-4 text-info" />,
        warning: <TriangleAlertIcon className="size-4 text-warning" />,
        // The inline alert's icon (brief 7.5): one sign for an error.
        error: <CircleAlertIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
        close: <XIcon className="size-4" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--width': '360px',
        } as React.CSSProperties
      }
      toastOptions={{
        closeButtonAriaLabel: 'Sulje',
        classNames: {
          toast: 'font-sans shadow-md!',
          // Errors' close button: a 28 px ghost icon button inside the toast, 16 px from its right
          // edge, not a corner dot (UI review 3); a 44 px target on phones.
          error: 'pr-13! max-md:pr-14!',
          closeButton:
            'top-1/2! right-4! left-auto! size-7! -translate-y-1/2! transform-none! rounded-md! border-0! bg-transparent! text-muted-foreground! hover:bg-accent! hover:text-foreground! max-md:right-1! max-md:size-11!',
          title: 'text-ui! font-medium!',
          description: 'text-meta! text-muted-foreground!',
          actionButton:
            'h-8! rounded-md! border! border-border! bg-transparent! text-foreground! max-md:h-11!',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
