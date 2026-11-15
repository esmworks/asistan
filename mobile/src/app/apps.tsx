import { useLocalSearchParams } from 'expo-router';
import { Browse } from '@/components/apps/Browse';
import { Detail } from '@/components/apps/Detail';
import { Setup } from '@/components/apps/Setup';

/**
 * The apps screen. No params: the catalog and the connections made. `connectionId`: that
 * connection. `catalogId`: adding that catalog service (`custom` for any other server); with a
 * `connectionId` too, a further account of that connection's service.
 */
export default function Screen() {
  const { connectionId, catalogId } = useLocalSearchParams<{
    botId?: string;
    connectionId?: string;
    catalogId?: string;
  }>();
  if (catalogId) return <Setup catalogId={catalogId} siblingId={connectionId} />;
  if (connectionId) return <Detail id={connectionId} />;
  return <Browse />;
}
