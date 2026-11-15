import { useLocalSearchParams } from 'expo-router';
import { BotEditor } from '@/components/dialogs/BotForm';

/** Create a bot, or edit the one in `botId`. */
export default function Screen() {
  const { botId } = useLocalSearchParams<{ botId?: string }>();
  return <BotEditor botId={botId || undefined} />;
}
