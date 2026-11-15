import type { Bot, Room } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { useBots } from '@/lib/queries';
import { useColors } from '@/lib/theme';

/** The bots of a room that still exist, in speaking order. */
export function useMembers(room: Room | undefined): Bot[] {
  const { data: bots } = useBots();
  return useMemo(
    () => (room?.members ?? []).map((id) => bots?.find((b) => b.id === id)).filter((b): b is Bot => !!b),
    [room?.members, bots],
  );
}

/** Up to three member avatars overlapping, as the room's picture. */
export function RoomFace({ members, size = 24 }: { members: Bot[]; size?: number }) {
  const c = useColors();
  const shown = members.slice(0, 3);
  if (!shown.length)
    return (
      <View
        style={[
          styles.empty,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: c.muted },
        ]}
      >
        <Feather name="users" size={Math.round(size * 0.55)} color={c.mutedForeground} />
      </View>
    );
  return (
    <View style={styles.row}>
      {shown.map((b, i) => (
        <View
          key={b.id}
          style={{ zIndex: shown.length - i, marginLeft: i > 0 ? -Math.round(size * 0.36) : 0 }}
        >
          <Avatar name={b.name} color={b.color} avatar={b.avatar} size={size} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
});
