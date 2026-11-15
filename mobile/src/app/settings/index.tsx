import { settingsMatch } from '@yumakbot/app/src/lib/settingsMatch';
import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Page, Row } from '@/components/page';
import { SECTIONS } from '@/components/settings/sections';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useColors } from '@/lib/theme';

/** The list of settings sections; the box narrows it to the ones whose name or contents match. */
export default function SettingsList() {
  const c = useColors();
  const [find, setFind] = useState('');
  const shown = SECTIONS.filter((s) =>
    settingsMatch(find, `${t(`settings.tab.${s.id}`)} ${t(`settings.keywords.${s.id}`)}`),
  );
  return (
    <Page title={t('settings.title')}>
      <View style={styles.search}>
        <TextInput
          value={find}
          onChangeText={setFind}
          placeholder={t('settings.search')}
          placeholderTextColor={c.mutedForeground}
          accessibilityLabel={t('settings.search')}
          returnKeyType="go"
          onSubmitEditing={() => shown[0] && nav.settings(shown[0].id)}
          style={[styles.input, { color: c.foreground, borderColor: c.border, backgroundColor: c.muted }]}
        />
      </View>
      {/* A plain list, without a card around it, as the web app's phone layout shows it. */}
      <View style={styles.list}>
        {shown.map((s) => (
          <Row
            key={s.id}
            icon={s.icon}
            label={t(`settings.tab.${s.id}`)}
            onPress={() => nav.settings(s.id)}
          />
        ))}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  search: { marginBottom: 4 },
  list: { marginHorizontal: -8 },
  input: { height: 40, borderRadius: 20, borderWidth: 1, paddingHorizontal: 16, fontSize: 17 },
});
