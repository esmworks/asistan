import { Image } from 'expo-image';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** A service's logo, served by the app's own server; its first letter when there is none. */
export function AppLogo({ id, name, size = 24 }: { id: string | null; name: string; size?: number }) {
  const c = useColors();
  const { origin } = useServer();
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size, borderRadius: Math.round(size / 3.2) };
  if (!id || failed || !origin) {
    return (
      <View style={[styles.box, box, { backgroundColor: c.background, borderColor: c.border }]}>
        <Text style={[styles.letter, { color: c.mutedForeground, fontSize: size * 0.45 }]}>
          {(name.trim()[0] ?? '?').toLocaleUpperCase()}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: `${origin}/connections/${id}.png` }}
      style={[styles.box, box, { backgroundColor: '#FFFFFF', borderColor: c.border }]}
      contentFit="contain"
      onError={() => setFailed(true)}
      accessible={false}
    />
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  letter: { fontWeight: '600' },
});
