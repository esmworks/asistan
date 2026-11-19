import { useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { Page, back, Empty, Loading } from '@/components/page';
import { RoomView } from '@/components/rooms/RoomView';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { useViewingThread } from '@/lib/push';
import { useRooms } from '@/lib/queries';

/** A room, while it exists. */
export default function Room() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const rooms = useRooms();
  const room = rooms.data?.find((r) => r.id === roomId);
  const gone = !!rooms.data && !rooms.isFetching && !room;
  useViewingThread(room?.id);

  // A room deleted here or elsewhere leaves nothing to show.
  useEffect(() => {
    if (gone) back();
  }, [gone]);

  if (room) return <RoomView key={room.id} room={room} />;
  return (
    <Page title={t('rooms.title')}>
      {rooms.isError ? (
        <>
          <Empty icon="alert-circle" text={t('chat.loadFailed')} />
          <Button label={t('common.retry')} onPress={() => void rooms.refetch()} />
        </>
      ) : (
        <Loading />
      )}
    </Page>
  );
}
