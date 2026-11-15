import {
  MAX_ROOM_MEMBERS,
  MAX_ROOM_ROUNDS,
  type Bot,
  type Room,
  type RoomResponders,
} from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { confirm, toastError } from '@/components/overlay';
import {
  LabeledInput,
  Note,
  Page,
  PillButton,
  Row,
  Section,
  Segments,
  Sheet,
  back,
  type SheetItem,
} from '@/components/page';
import { t } from '@/i18n';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** The room editor as a page: name, members in speaking order, goal, and how the bots talk. */
export function RoomForm({ room, bots, title }: { room?: Room; bots: Bot[]; title: string }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [name, setName] = useState(room?.title ?? '');
  const [goal, setGoal] = useState(room?.goal ?? '');
  const [picked, setPicked] = useState<string[]>(room?.members ?? []);
  const [responders, setResponders] = useState<RoomResponders>(room?.responders ?? 'everyone');
  const [rounds, setRounds] = useState(room?.rounds ?? 0);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_ROOM_MEMBERS ? p : [...p, id],
    );
  const valid = !!name.trim() && picked.length > 0;

  const save = useMutation({
    mutationFn: () => {
      const input = { title: name.trim(), goal: goal.trim(), botIds: picked, responders, rounds };
      return room ? api.updateRoom(room.id, input) : api.createRoom(input);
    },
    onSuccess: (saved) => {
      // In the list at once, so the room screen finds it before the list is fetched again.
      qc.setQueryData<Room[]>(['rooms', origin], (old = []) => [
        saved,
        ...old.filter((r) => r.id !== saved.id),
      ]);
      void qc.invalidateQueries({ queryKey: ['rooms', origin] });
      // Replacing this page with the room keeps back from the room on the list, with no timer.
      if (!room) router.replace({ pathname: '/room/[roomId]', params: { roomId: saved.id } });
      else back();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRoom(room!.id),
    onSuccess: () => {
      back();
      void qc.invalidateQueries({ queryKey: ['rooms', origin] });
    },
    onError: toastError,
  });
  const submit = () => {
    setTried(true);
    if (valid) save.mutate();
  };

  const roundItems: SheetItem[] = Array.from({ length: MAX_ROOM_ROUNDS + 1 }, (_, n) => ({
    label: n ? t('room.roundsN', { count: n }) : t('room.roundsOff'),
    selected: n === rounds,
    onPress: () => setRounds(n),
  }));

  return (
    <Page title={title}>
      <View style={styles.form}>
        <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('room.dialogHint')}</Text>
        <LabeledInput
          label={t('room.name')}
          value={name}
          onChangeText={setName}
          placeholder={t('room.namePlaceholder')}
          maxLength={120}
          autoFocus={!room}
          returnKeyType="done"
        />
        {tried && !name.trim() ? <Note tone="error">{t('room.nameRequired')}</Note> : null}

        <View style={styles.group}>
          <Text style={[styles.label, { color: c.foreground }]}>{t('room.members')}</Text>
          {bots.length ? (
            <>
              <View style={[styles.list, { borderColor: c.border, backgroundColor: c.card }]}>
                {bots.map((b) => {
                  const at = picked.indexOf(b.id);
                  return (
                    <Pressable
                      key={b.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: at >= 0 }}
                      onPress={() => toggle(b.id)}
                      style={({ pressed }) => [
                        styles.bot,
                        (at >= 0 || pressed) && { backgroundColor: c.accent },
                      ]}
                    >
                      <Avatar name={b.name} color={b.color} avatar={b.avatar} size={32} />
                      <View style={styles.botText}>
                        <Text style={[styles.botName, { color: c.foreground }]} numberOfLines={1}>
                          {b.name}
                        </Text>
                        {b.description ? (
                          <Text style={[styles.botHint, { color: c.mutedForeground }]} numberOfLines={1}>
                            {b.description}
                          </Text>
                        ) : null}
                      </View>
                      <View
                        style={[
                          styles.badge,
                          at >= 0
                            ? { backgroundColor: c.primary, borderColor: c.primary }
                            : { borderColor: c.border },
                        ]}
                      >
                        {at >= 0 ? (
                          <Text style={[styles.badgeText, { color: c.primaryForeground }]}>{at + 1}</Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('room.membersHint')}</Text>
            </>
          ) : (
            <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('room.noBots')}</Text>
          )}
          {tried && !picked.length ? <Note tone="error">{t('room.pickOne')}</Note> : null}
        </View>

        <LabeledInput
          label={t('room.goal')}
          value={goal}
          onChangeText={setGoal}
          placeholder={t('room.goalPlaceholder')}
          maxLength={4000}
          multiline
        />

        <View style={styles.group}>
          <Text style={[styles.label, { color: c.foreground }]}>{t('room.responders')}</Text>
          <Segments
            value={responders}
            onChange={setResponders}
            options={[
              { value: 'everyone', label: t('room.respondersEveryone') },
              { value: 'mentions', label: t('room.respondersMentions') },
            ]}
          />
        </View>

        <View style={styles.group}>
          <Text style={[styles.label, { color: c.foreground }]}>{t('room.rounds')}</Text>
          <Section>
            <Row
              label={rounds ? t('room.roundsN', { count: rounds }) : t('room.roundsOff')}
              onPress={() => setRoundsOpen(true)}
            />
          </Section>
        </View>

        <View style={styles.actions}>
          {room ? (
            <PillButton
              label={t('room.delete')}
              variant="ghost"
              busy={remove.isPending}
              onPress={() =>
                void confirm({
                  title: t('room.delete'),
                  message: t('room.deleteConfirm', { name: room.title }),
                  confirmLabel: t('room.delete'),
                  destructive: true,
                }).then((ok) => ok && remove.mutate())
              }
            />
          ) : null}
          <View style={styles.spacer} />
          <PillButton
            label={room ? t('common.save') : t('room.create')}
            variant="primary"
            busy={save.isPending}
            disabled={!bots.length}
            onPress={submit}
          />
        </View>
      </View>
      <Sheet
        open={roundsOpen}
        onClose={() => setRoundsOpen(false)}
        title={t('room.rounds')}
        items={roundItems}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  group: { gap: 6 },
  label: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 15, lineHeight: 20 },
  list: { borderWidth: 1, borderRadius: 16, padding: 4, gap: 2 },
  bot: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 12, padding: 8 },
  botText: { flex: 1, gap: 1 },
  botName: { fontSize: 17, fontWeight: '500' },
  botHint: { fontSize: 15 },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 13, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  spacer: { flex: 1 },
});
