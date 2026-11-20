import { formHeaders, headerNameAllowed, type Connection, type ConnectionAuth } from '@yumakbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { IconButton, LabeledInput, PillButton, Row, Section } from '@/components/page';
import { t } from '@/i18n';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Extra request headers for the server, such as an API key under the name the service wants. Only
 * the names come back from the server: each shows as saved, and one is changed by adding it again.
 */
export function RequestHeaders({ connection }: { connection: Connection }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const names = connection.headerNames ?? [];
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const trimmed = name.trim();
  // A name the server would refuse is flagged while typing, not after a failed save.
  const blocked = !!trimmed && !headerNameAllowed(trimmed, connection.auth);
  // The whole list goes each time; a name sent with no value keeps what is saved under it.
  const save = useMutation({
    mutationFn: (headers: { name: string; value: string }[]) =>
      api.updateConnection(connection.id, { headers }),
    onSuccess: () => {
      setName('');
      setValue('');
      void qc.invalidateQueries({ queryKey: ['connections', origin] });
    },
    onError: toastError,
  });
  const kept = (except?: string) =>
    names.filter((n) => n.toLowerCase() !== except?.toLowerCase()).map((n) => ({ name: n, value: '' }));
  const ready = !!trimmed && !!value && !blocked;
  return (
    <Section title={t('apps.headers')} footer={t('apps.headersHint')}>
      {names.map((n) => (
        <Row
          key={n}
          label={n}
          value={t('apps.headerSaved')}
          chevron={false}
          right={
            <IconButton
              icon="trash-2"
              label={t('common.remove')}
              size={20}
              disabled={save.isPending}
              onPress={() => save.mutate(kept(n))}
            />
          }
        />
      ))}
      <View style={styles.form}>
        <LabeledInput
          label={t('apps.headerName')}
          hint={blocked ? t('apps.headerNameBlocked') : undefined}
          value={name}
          onChangeText={setName}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
        />
        <LabeledInput
          label={t('apps.headerValue')}
          value={value}
          onChangeText={setValue}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
        />
        <View style={styles.save}>
          <PillButton
            label={t('apps.headerAdd')}
            variant="primary"
            disabled={!ready}
            busy={save.isPending}
            onPress={() => save.mutate([...kept(trimmed), { name: trimmed, value }])}
          />
        </View>
      </View>
    </Section>
  );
}

export interface HeaderDraft {
  name: string;
  value: string;
}

/**
 * Request headers for a server being added, sent with it. A name the server would refuse for the
 * chosen sign-in is flagged here, and holds the form back, rather than failing the whole connect.
 */
export function NewHeaders({
  headers,
  onChange,
  typed,
  onType,
  auth,
}: {
  headers: HeaderDraft[];
  onChange(headers: HeaderDraft[]): void;
  typed: HeaderDraft;
  onType(typed: HeaderDraft): void;
  auth: ConnectionAuth;
}) {
  const c = useColors();
  const name = typed.name.trim();
  const blocked = !!name && !headerNameAllowed(name, auth);
  const addTyped = () => {
    if (!name || !typed.value || blocked) return;
    onChange(formHeaders(headers, typed));
    onType({ name: '', value: '' });
  };
  return (
    <View style={styles.newHeaders}>
      <Text style={[styles.label, { color: c.foreground }]}>{t('apps.headers')}</Text>
      <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('apps.headersHint')}</Text>
      {headers.map((h) => (
        <View key={h.name.toLowerCase()} style={styles.added}>
          <View style={styles.addedText}>
            <Text style={[styles.addedName, { color: c.foreground }]} numberOfLines={1}>
              {h.name}
            </Text>
            {headerNameAllowed(h.name, auth) ? null : (
              <Text style={[styles.hint, { color: c.destructive }]}>{t('apps.headerNameBlocked')}</Text>
            )}
          </View>
          <IconButton
            icon="trash-2"
            label={t('common.remove')}
            size={20}
            onPress={() => onChange(headers.filter((x) => x !== h))}
          />
        </View>
      ))}
      <LabeledInput
        label={t('apps.headerName')}
        hint={blocked ? t('apps.headerNameBlocked') : undefined}
        value={typed.name}
        onChangeText={(v) => onType({ ...typed, name: v })}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />
      <LabeledInput
        label={t('apps.headerValue')}
        value={typed.value}
        onChangeText={(v) => onType({ ...typed, value: v })}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />
      <View style={styles.save}>
        <PillButton
          label={t('apps.headerAdd')}
          disabled={!name || !typed.value || blocked}
          onPress={addTyped}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10, padding: 16 },
  save: { alignItems: 'flex-end' },
  newHeaders: { gap: 6 },
  label: { fontSize: 16, fontWeight: '500', paddingHorizontal: 4 },
  hint: { fontSize: 14, lineHeight: 19, paddingHorizontal: 4 },
  added: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  addedText: { flex: 1, gap: 2 },
  addedName: { fontSize: 16, fontWeight: '500' },
});
