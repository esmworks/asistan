import { PROFILE_FOCUS, PROFILE_HELP, type ProfileFocus, type ProfileHelp } from '@yumakbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Avatar } from '@/components/Avatar';
import { PillButton } from '@/components/page';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { useColors } from '@/lib/theme';
import { Chip } from './Chip';
import { ROLES, type Role } from './profile';

export type Question = 'name' | 'addressAs' | 'focus' | 'occupation' | 'helpWith' | 'about';
const QUESTIONS: Question[] = ['name', 'addressAs', 'focus', 'occupation', 'helpWith', 'about'];

export interface Answers {
  name: string;
  addressAs: string;
  focus?: ProfileFocus;
  roles: Role[];
  roleText: string;
  helpWith: ProfileHelp[];
  about: string;
}

export const EMPTY_ANSWERS: Answers = {
  name: '',
  addressAs: '',
  roles: [],
  roleText: '',
  helpWith: [],
  about: '',
};

export function occupationText(a: Answers): string {
  return [...a.roles.map((r) => t(`onboarding.role.${r}`)), a.roleText.trim()].filter(Boolean).join(', ');
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] ?? '';
}

/** The questions as a talk: the bot asks, the person answers by typing or tapping, and may edit an answer. */
export function AboutStep({
  answers,
  resume,
  onChange,
  onNext,
}: {
  answers: Answers;
  resume: boolean;
  onChange: (a: Answers) => void;
  onNext: () => void;
}) {
  const c = useColors();
  const [seen, setSeen] = useState<Question[]>(resume ? QUESTIONS : []);
  const [current, setCurrent] = useState<Question | 'done'>(resume ? 'done' : 'name');
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scroller = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  // The keyboard shrinks the view without changing the talk, so the question in hand would stay
  // under it.
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () =>
      scroller.current?.scrollToEnd({ animated: true }),
    );
    return () => sub.remove();
  }, []);

  const answered = (q: Question, next: Answers) => {
    onChange(next);
    const nowSeen = seen.includes(q) ? seen : [...seen, q];
    setSeen(nowSeen);
    const upcoming = QUESTIONS.find((x) => !nowSeen.includes(x));
    if (!upcoming) {
      setCurrent('done');
      onNext();
      return;
    }
    setCurrent(upcoming);
    clearTimeout(timer.current);
    setTyping(true);
    timer.current = setTimeout(() => setTyping(false), 650);
  };

  const shown = (q: Question): string | null => {
    if (q === 'name') return answers.name || null;
    if (q === 'addressAs') return answers.addressAs || null;
    if (q === 'focus') return answers.focus ? t(`profile.focus.${answers.focus}`) : null;
    if (q === 'occupation') return occupationText(answers) || null;
    if (q === 'helpWith') return answers.helpWith.map((h) => t(`profile.help.${h}`)).join(', ') || null;
    return answers.about || null;
  };

  const turns: ReactNode[] = [];
  for (const [i, q] of QUESTIONS.entries()) {
    const live = q === current;
    if (!live && !seen.includes(q)) break;
    if (live && typing) break;
    turns.push(
      <BotSays key={`${q}-ask`}>
        {i === 0 ? <Text style={[styles.say, { color: c.foreground }]}>{t('onboarding.intro')}</Text> : null}
        <Text style={[styles.say, styles.ask, { color: c.foreground }]}>{t(`onboarding.q.${q}`)}</Text>
        {(q === 'occupation' || q === 'helpWith') && live ? (
          <Text style={[styles.say, { color: c.mutedForeground }]}>{t('onboarding.pickMany')}</Text>
        ) : null}
      </BotSays>,
    );
    if (live) {
      turns.push(
        <AnswerInput
          key={`${q}-input`}
          question={q}
          answers={answers}
          onAnswer={(next) => answered(q, next)}
        />,
      );
      break;
    }
    turns.push(
      <PersonSays key={`${q}-answer`} onEdit={() => setCurrent(q)}>
        {shown(q) ?? <Text style={{ color: c.mutedForeground }}>{t('onboarding.skipped')}</Text>}
      </PersonSays>,
    );
  }
  if (typing) turns.push(<Typing key="typing" />);

  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        ref={(r) => {
          scroller.current = r;
        }}
        style={styles.fill}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onContentSizeChange={() => scroller.current?.scrollToEnd({ animated: true })}
      >
        {turns}
        {current === 'done' ? (
          <View style={styles.end}>
            <PillButton label={t('onboarding.continue')} variant="primary" onPress={onNext} />
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function AnswerInput({
  question,
  answers,
  onAnswer,
}: {
  question: Question;
  answers: Answers;
  onAnswer: (next: Answers) => void;
}) {
  const c = useColors();
  const [draft, setDraft] = useState(() =>
    question === 'name'
      ? answers.name
      : question === 'addressAs'
        ? answers.addressAs || firstName(answers.name)
        : question === 'about'
          ? answers.about
          : '',
  );
  const [roles, setRoles] = useState<Role[]>(answers.roles);
  const [roleText, setRoleText] = useState(answers.roleText);
  const [other, setOther] = useState(!!answers.roleText);
  const [help, setHelp] = useState<ProfileHelp[]>(answers.helpWith);
  const skip = (patch: Partial<Answers>) => (
    <PillButton
      label={t('onboarding.skipQuestion')}
      variant="ghost"
      onPress={() => onAnswer({ ...answers, ...patch })}
    />
  );

  if (question === 'name' || question === 'addressAs' || question === 'about') {
    const submit = () => {
      const value = draft.trim();
      if (value) onAnswer({ ...answers, [question]: value });
    };
    const empty =
      question === 'name' ? { name: '' } : question === 'addressAs' ? { addressAs: '' } : { about: '' };
    return (
      <View style={styles.input}>
        {question === 'about' ? (
          <Field
            value={draft}
            onChangeText={setDraft}
            maxLength={2000}
            multiline
            autoFocus
            accessibilityLabel={t('onboarding.q.about')}
            placeholder={t('profile.aboutPlaceholder')}
            style={styles.area}
          />
        ) : (
          <Field
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submit}
            returnKeyType="done"
            maxLength={question === 'name' ? 80 : 60}
            autoFocus
            autoComplete={question === 'name' ? 'name' : 'off'}
            accessibilityLabel={t(`onboarding.q.${question}`)}
            placeholder={t('onboarding.typeHere')}
            style={styles.line}
          />
        )}
        <View style={styles.buttons}>
          {skip(empty)}
          <PillButton
            label={t('onboarding.continue')}
            variant="primary"
            disabled={!draft.trim()}
            onPress={submit}
          />
        </View>
      </View>
    );
  }

  if (question === 'focus') {
    return (
      <View style={styles.input}>
        <View style={styles.chips}>
          {PROFILE_FOCUS.map((f) => (
            <Chip
              key={f}
              on={answers.focus === f}
              label={t(`profile.focus.${f}`)}
              onPress={() => onAnswer({ ...answers, focus: f })}
            />
          ))}
        </View>
        <View style={styles.buttons}>{skip({ focus: undefined })}</View>
      </View>
    );
  }

  if (question === 'occupation') {
    const toggle = (r: Role) => setRoles((rs) => (rs.includes(r) ? rs.filter((x) => x !== r) : [...rs, r]));
    const ready = roles.length > 0 || !!roleText.trim();
    const done = () => onAnswer({ ...answers, roles, roleText: roleText.trim() });
    return (
      <View style={styles.input}>
        <View style={styles.chips}>
          {ROLES.map((r) => (
            <Chip
              key={r}
              check
              on={roles.includes(r)}
              label={t(`onboarding.role.${r}`)}
              onPress={() => toggle(r)}
            />
          ))}
          {other ? null : (
            <Chip
              on={false}
              label={t('onboarding.other')}
              icon={<Feather name="edit-2" size={14} color={c.foreground} />}
              onPress={() => setOther(true)}
            />
          )}
        </View>
        {other ? (
          <Field
            value={roleText}
            onChangeText={setRoleText}
            onSubmitEditing={() => ready && done()}
            returnKeyType="done"
            maxLength={120}
            autoFocus
            accessibilityLabel={t('onboarding.other')}
            placeholder={t('profile.occupationPlaceholder')}
            style={styles.line}
          />
        ) : null}
        <View style={styles.buttons}>
          {skip({ roles: [], roleText: '' })}
          <PillButton label={t('onboarding.continue')} variant="primary" disabled={!ready} onPress={done} />
        </View>
      </View>
    );
  }

  // helpWith
  const toggle = (h: ProfileHelp) =>
    setHelp((hs) =>
      hs.includes(h) ? hs.filter((x) => x !== h) : PROFILE_HELP.filter((x) => x === h || hs.includes(x)),
    );
  return (
    <View style={styles.input}>
      <View style={styles.chips}>
        {PROFILE_HELP.map((h) => (
          <Chip
            key={h}
            check
            on={help.includes(h)}
            label={t(`profile.help.${h}`)}
            onPress={() => toggle(h)}
          />
        ))}
      </View>
      <View style={styles.buttons}>
        {skip({ helpWith: [] })}
        <PillButton
          label={t('onboarding.continue')}
          variant="primary"
          disabled={!help.length}
          onPress={() => onAnswer({ ...answers, helpWith: help })}
        />
      </View>
    </View>
  );
}

function BotSays({ children }: { children: ReactNode }) {
  const c = useColors();
  return (
    <View style={styles.botRow}>
      <Avatar name="" color={c.brand} avatar="shape:blob" size={32} />
      <View style={[styles.botBubble, { backgroundColor: c.muted }]}>{children}</View>
    </View>
  );
}

function PersonSays({ children, onEdit }: { children: ReactNode; onEdit: () => void }) {
  const c = useColors();
  return (
    <View style={styles.personRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('onboarding.editAnswer')}
        onPress={onEdit}
        hitSlop={8}
        style={styles.edit}
      >
        <Feather name="edit-2" size={14} color={c.mutedForeground} />
      </Pressable>
      <View style={[styles.personBubble, { backgroundColor: `${c.brand}1F` }]}>
        <Text style={[styles.say, { color: c.foreground }]}>{children}</Text>
      </View>
    </View>
  );
}

function Typing() {
  const c = useColors();
  return (
    <View style={styles.botRow}>
      <Avatar name="" color={c.brand} avatar="shape:blob" size={32} />
      <View style={[styles.botBubble, styles.typing, { backgroundColor: c.muted }]} accessible={false}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.dot, { backgroundColor: c.mutedForeground }]} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 20, paddingBottom: 40, gap: 16 },
  end: { alignItems: 'flex-end' },
  botRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  botBubble: {
    maxWidth: '85%',
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 4,
  },
  say: { fontSize: 15, lineHeight: 22 },
  ask: { fontWeight: '500' },
  personRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  personBubble: {
    maxWidth: '80%',
    borderRadius: 18,
    borderBottomRightRadius: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  edit: { padding: 6 },
  input: { alignItems: 'flex-end', gap: 12, paddingLeft: 44 },
  line: { alignSelf: 'stretch' },
  area: { alignSelf: 'stretch', minHeight: 88, textAlignVertical: 'top' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  buttons: { flexDirection: 'row', gap: 8 },
  typing: { flexDirection: 'row', gap: 4, paddingVertical: 15 },
  dot: { width: 6, height: 6, borderRadius: 3, opacity: 0.6 },
});
