import type { BotActivity } from '@yumakbot/app/src/lib/activity';
import type { AvatarShape } from '@yumakbot/shared';
import { INTL_LOCALE } from '@yumakbot/shared/i18n';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { PlushEyes, type EyeMotion } from '@/components/PlushEyes';
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

/** How much larger than its box the body picture is drawn; its fur margin is about a third of it. */
const ART_ZOOM = 1.38;

/**
 * A bot's mark: its uploaded picture, or its shape as a felt plush in its color with two eyes, as
 * the web app draws its bots. Without an avatar (a profile, an app) it is the first letter on a disc.
 * A plush given `motion` looks around and blinks; without it the plush is a picture, as where the
 * avatar only names the bot.
 */
export function Avatar({
  name,
  color,
  size,
  avatar,
  motion,
  seed,
  activity,
}: {
  name: string;
  color: string;
  size: number;
  /** The bot's avatar field: `shape:<name>`, `object:<id>` or an uploaded picture as a data URL. */
  avatar?: string;
  /** How a plush's eyes move; left out, they hold still. */
  motion?: EyeMotion;
  /** The bot's id: its avatars look and blink together, and act out what it is doing. */
  seed?: string;
  /** What the bot is doing, where the screen knows better than the bot's own conversation. */
  activity?: BotActivity;
}) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  if (avatar?.startsWith('data:image/')) {
    return <Image source={{ uri: avatar }} style={round} contentFit="cover" accessible={false} />;
  }
  // An object avatar is drawn with volume by the desktop app; the phone shows the plain plush.
  if (avatar?.startsWith('shape:') || avatar?.startsWith('object:')) {
    const body = (avatar.startsWith('shape:') && BODIES[avatar.slice(6) as AvatarShape]) || BLOB;
    // The body picture has room around the shape for its fur, so it is drawn larger than the box
    // and the shape nearly fills it.
    const span = size * ART_ZOOM;
    const offset = (size - span) / 2;
    const art = { width: span, height: span, left: offset, top: offset };
    const eye = { width: span * 0.057, height: span * 0.126, borderRadius: size };
    // Eye centres, as fractions of the body picture.
    const at = (f: number, length: number) => offset + f * span - length / 2;
    const leftEye = { top: at(0.476, eye.height), left: at(0.448, eye.width) };
    const rightEye = { top: at(0.476, eye.height), left: at(0.587, eye.width) };
    return (
      <View style={[styles.plush, { width: size, height: size }]} accessible={false}>
        {/* The colour fills the shape, then the grey fur lights and shades it. */}
        <Image source={body} style={[styles.layer, art]} tintColor={color} />
        <Image source={body} style={[styles.layer, styles.fur, art]} />
        {motion ? (
          <PlushEyes
            seed={seed}
            activity={activity}
            motion={motion}
            span={span}
            eye={[styles.eye, eye]}
            left={leftEye}
            right={rightEye}
          />
        ) : (
          <>
            <View style={[styles.eye, eye, leftEye]} />
            <View style={[styles.eye, eye, rightEye]} />
          </>
        )}
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
