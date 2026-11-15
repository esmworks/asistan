import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import * as WebBrowser from 'expo-web-browser';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Row, Section } from '@/components/page';
import { Pad, Rows } from './common/controls';
import { t } from '@/i18n';
import { useInfo } from '@/lib/queries';
import { useColors } from '@/lib/theme';
// The app's own icon, the same picture the web app shows here.
import LOGO from '../../../assets/logo.png';

/**
 * Copyright, license and source notices required by the AGPL. The NOTICE file's additional terms
 * oblige anyone who conveys or hosts a modified version to keep the product attribution and the
 * repository link visible here.
 */
const REPO_URL = 'https://github.com/esmworks/yumakbot';

/** A new issue with the version and the device filled in, so a report starts with what it needs. */
function issueUrl(version: string | undefined): string {
  const body = [
    `Version: ${version ?? '?'}`,
    `Device: ${Platform.OS} ${String(Platform.Version)}`,
    '',
    '',
  ].join('\n');
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

/** The "about" settings section's content, under the section's own title bar. */
export function AboutSection() {
  const c = useColors();
  const { data: info } = useInfo();
  const link = (href: string, label: string, hint = href.replace('https://', '')) => (
    <Row
      label={label}
      detail={hint}
      chevron={false}
      onPress={() => void WebBrowser.openBrowserAsync(href)}
      right={<Feather name="external-link" size={18} color={c.mutedForeground} />}
    />
  );
  return (
    <>
      <View style={styles.head}>
        <Image source={LOGO} style={styles.logo} accessible={false} />
        <View style={styles.headText}>
          <Text style={[styles.name, { color: c.foreground }]}>{t('about.name')}</Text>
          <Text style={[styles.version, { color: c.mutedForeground }]}>
            {t('about.version', { version: info?.version ?? '…' })}
          </Text>
        </View>
      </View>
      <Section title={t('about.license')}>
        <Pad gap={8}>
          <Text style={[styles.text, { color: c.foreground }]}>{t('about.copyright')}</Text>
          <Text style={[styles.text, { color: c.mutedForeground }]}>{t('about.licenseText')}</Text>
          <Text style={[styles.text, { color: c.mutedForeground }]}>{t('about.warranty')}</Text>
        </Pad>
      </Section>
      <Section title={t('about.links')}>
        <Rows>
          {link(REPO_URL, t('about.source'))}
          {link(`${REPO_URL}/blob/main/LICENSE`, t('about.licenseLink'))}
          {link(`${REPO_URL}/blob/main/NOTICE`, t('about.notice'))}
          {link(issueUrl(info?.version), t('about.report'), t('about.reportHint'))}
        </Rows>
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 4 },
  logo: { width: 56, height: 56, borderRadius: 14 },
  headText: { flex: 1, gap: 2 },
  name: { fontSize: 18, fontWeight: '600' },
  version: { fontSize: 14 },
  text: { fontSize: 14, lineHeight: 20 },
});
