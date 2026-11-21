import type { BotActivity } from '@leafbot/app/src/lib/activity';
import { INTL_LOCALE } from '@leafbot/shared/i18n';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { ObjectAvatar, type AvatarMotion } from '@/components/ObjectAvatar';
import { locale } from '@/i18n';
import { initialOf } from '@/lib/bots';

/**
 * A bot's mark: its uploaded picture, or its object (a circle, a mug, a sprout) with volume and eyes,
 * as the web app draws it; an old shape is drawn as the circle. Without an avatar (a profile, an app)
 * it is the first letter on a disc. An object given `motion` moves; without it it is a picture, as
 * where the avatar only names the bot.
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
  /** How an object moves; left out, it holds still. */
  motion?: AvatarMotion;
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
    // An old shape the server has not turned into the round object yet is drawn as one.
    const id = avatar.startsWith('object:') ? avatar.slice('object:'.length) : 'circle';
    return <ObjectAvatar id={id} color={color} size={size} motion={motion} seed={seed} activity={activity} />;
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
  letter: { color: '#FFFFFF', fontWeight: '600' },
});
