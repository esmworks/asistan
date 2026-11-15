import type { AvatarShape } from '@yumakbot/shared';
import { INTL_LOCALE } from '@yumakbot/shared/i18n';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { locale } from '@/i18n';
import { initialOf } from '@/lib/bots';
import BLOB from '../../assets/plush/blob.webp';
import CAPSULE from '../../assets/plush/capsule.webp';
import CLOUD from '../../assets/plush/cloud.webp';
import DIAMOND from '../../assets/plush/diamond.webp';
import DROP from '../../assets/plush/drop.webp';
import HEXAGON from '../../assets/plush/hexagon.webp';
import PEBBLE from '../../assets/plush/pebble.webp';
import PENTAGON from '../../assets/plush/pentagon.webp';
import SQUARE from '../../assets/plush/square.webp';
import SQUIRCLE from '../../assets/plush/squircle.webp';
import TRIANGLE from '../../assets/plush/triangle.webp';

/**
 * Each shape's felt body: a grey picture whose light and shade the bot's colour is laid under.
 * Shapes no longer offered take the nearest body.
 */
const BODIES: Record<AvatarShape, number> = {
  blob: BLOB,
  pebble: PEBBLE,
  squircle: SQUIRCLE,
  capsule: CAPSULE,
  drop: DROP,
  square: SQUARE,
  diamond: DIAMOND,
  hexagon: HEXAGON,
  pentagon: PENTAGON,
  triangle: TRIANGLE,
  cloud: CLOUD,
  clover: CLOUD,
  star: PENTAGON,
  shield: PENTAGON,
  leaf: PEBBLE,
  bolt: TRIANGLE,
  moon: CAPSULE,
};

/**
 * A bot's mark: its uploaded picture, or its shape as a felt plush in its color with two eyes, as
 * the web app draws its bots. Without an avatar (a profile, an app) it is the first letter on a disc.
 */
export function Avatar({
  name,
  color,
  size,
  avatar,
}: {
  name: string;
  color: string;
  size: number;
  /** The bot's avatar field: `shape:<name>` or an uploaded picture as a data URL. */
  avatar?: string;
}) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (avatar?.startsWith('data:image/')) {
    return <Image source={{ uri: avatar }} style={round} contentFit="cover" accessible={false} />;
  }
  if (avatar?.startsWith('shape:')) {
    const body = BODIES[avatar.slice(6) as AvatarShape] ?? BLOB;
    // The body picture has room around the shape for its fur, so it is drawn larger than the box.
    const art = { width: size * 1.15, height: size * 1.15, left: size * -0.075, top: size * -0.075 };
    const eye = {
      width: size * 0.066,
      height: size * 0.145,
      borderRadius: size,
      top: size * 0.4,
    };
    return (
      <View style={[styles.plush, { width: size, height: size }]} accessible={false}>
        {/* The colour fills the shape, then the grey fur lights and shades it. */}
        <Image source={body} style={[styles.layer, art]} tintColor={color} />
        <Image source={body} style={[styles.layer, styles.fur, art]} />
        <View style={[styles.eye, eye, { left: size * 0.407 }]} />
        <View style={[styles.eye, eye, { left: size * 0.567 }]} />
      </View>
    );
  }
  return (
    <View style={[styles.center, round, { backgroundColor: color }]} accessible={false}>
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.42) }]} allowFontScaling={false}>
        {initialOf(name, INTL_LOCALE[locale])}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  plush: { isolation: 'isolate' },
  layer: { position: 'absolute' },
  fur: { mixBlendMode: 'hard-light' },
  eye: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.95)' },
  letter: { color: '#FFFFFF', fontWeight: '600' },
});
