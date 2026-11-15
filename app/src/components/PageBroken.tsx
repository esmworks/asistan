import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';

/** What shows when a part of the page fails to draw: a plain line and a way to load it again. */
export function PageBroken() {
  const t = useT();
  return (
    <div
      role="alert"
      className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center"
    >
      <p className="max-w-sm text-sm text-muted-foreground">{t('page.broken')}</p>
      <Button className="rounded-full" onClick={() => window.location.reload()}>
        <RotateCw /> {t('page.reload')}
      </Button>
    </div>
  );
}
