import { useLocalSearchParams } from 'expo-router';
import { SearchView } from '@/components/dialogs/SearchView';

export default function Screen() {
  const { q } = useLocalSearchParams<{ q?: string }>();
  return <SearchView initialQuery={q || undefined} />;
}
