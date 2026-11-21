import type { BotActivity } from '@leafbot/app/src/lib/activity';
import { INTL_LOCALE } from '@leafbot/shared/i18n';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { PlushEyes, type EyeMotion } from '@/components/PlushEyes';
import { locale } from '@/i18n';
import { initialOf } from '@/lib/bots';
import ROUND from '../../assets/round-body.webp';

/** How much larger than its box the body picture is drawn: the round body fills the box, the rest is margin. */
const ART_ZOOM = 1.38;

/**
 * A bot's mark: its uploaded picture, or the round body in its colour with two eyes, as the logo draws
 * Leaf Bot. The desktop app draws a bot's object with volume; the phone gives every bot the round
 * body, old shapes included. Without an avatar (a profile, an app) it is the first letter on a disc. A
 * body given `motion` looks around and blinks; without it it is a picture, as where the avatar only
 * names the bot.
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
  /** How the eyes move; left out, they hold still. */
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
  if (avatar?.startsWith('shape:') || avatar?.startsWith('object:')) {
    // The body picture has room around it, so it is drawn larger than the box and the body fills it.
    const span = size * ART_ZOOM;
    const offset = (size - span) / 2;
    const art = { width: span, height: span, left: offset, top: offset };
    // Tall eyes about a fifth of the body's height, as on the logo.
    const eye = { width: span * 0.064, height: span * 0.152, borderRadius: size };
    // Eye centres, as fractions of the body picture.
    const at = (f: number, length: number) => offset + f * span - length / 2;
    const leftEye = { top: at(0.476, eye.height), left: at(0.448, eye.width) };
    const rightEye = { top: at(0.476, eye.height), left: at(0.587, eye.width) };
    return (
      <View style={[styles.body, { width: size, height: size }]} accessible={false}>
        {/* The colour fills the body, then the grey picture lights and shades it. */}
        <Image source={ROUND} style={[styles.layer, art]} tintColor={color} />
        <Image source={ROUND} style={[styles.layer, styles.shade, art]} />
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
  body: { isolation: 'isolate' },
  layer: { position: 'absolute' },
  shade: { mixBlendMode: 'hard-light' },
  eye: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.95)' },
  letter: { color: '#FFFFFF', fontWeight: '600' },
});
