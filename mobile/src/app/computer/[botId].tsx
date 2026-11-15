import { useLocalSearchParams } from 'expo-router';
import { Empty, Loading, Page } from '@/components/page';
import { BrowserView, DesktopView } from '@/components/panel/ComputerView';
import { t } from '@/i18n';
import { useBots, useInfo } from '@/lib/queries';

/** The bot's browser, or its computer when the server gives bots one, as the web app's phone view. */
export default function ComputerScreen() {
  const { botId } = useLocalSearchParams<{ botId: string }>();
  const bots = useBots();
  const info = useInfo();
  const bot = bots.data?.find((b) => b.id === botId);
  if (!bot || !info.data) {
    return (
      <Page title="" scroll={false}>
        {bots.isLoading || info.isLoading ? (
          <Loading />
        ) : (
          <Empty icon="alert-circle" text={t('panel.loadFailed')} />
        )}
      </Page>
    );
  }
  const desktop = info.data.computer.status === 'ok';
  if (!desktop && info.data.browser.status !== 'ok') {
    return (
      <Page title={t('computer.browserTitleOf', { name: bot.name })} scroll={false}>
        <Empty icon="monitor" text={t('computer.unavailable')} />
      </Page>
    );
  }
  return (
    <Page
      title={t(desktop ? 'computer.titleOf' : 'computer.browserTitleOf', { name: bot.name })}
      scroll={false}
    >
      {desktop ? <DesktopView bot={bot} /> : <BrowserView bot={bot} />}
    </Page>
  );
}
