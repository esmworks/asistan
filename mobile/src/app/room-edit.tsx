import { useLocalSearchParams } from 'expo-router';
import { Empty, Loading, Page } from '@/components/page';
import { RoomForm } from '@/components/rooms/RoomForm';
import { t } from '@/i18n';
import { useBots, useRooms } from '@/lib/queries';

/** Starting a room (no `roomId`), or changing who is in it and how they talk. */
export default function RoomEdit() {
  const { roomId } = useLocalSearchParams<{ roomId?: string }>();
  const rooms = useRooms();
  const bots = useBots();
  const room = roomId ? rooms.data?.find((r) => r.id === roomId) : undefined;
  const title = roomId ? t('room.dialogEdit') : t('room.dialogCreate');
  if (!bots.data || (roomId && !rooms.data))
    return (
      <Page title={title}>
        <Loading />
      </Page>
    );
  if (roomId && !room)
    return (
      <Page title={title}>
        <Empty icon="users" text={t('chat.loadFailed')} />
      </Page>
    );
  return <RoomForm key={room?.id ?? 'new'} room={room} bots={bots.data} title={title} />;
}
