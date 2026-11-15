import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { toastError } from '@/components/overlay';
import { PillButton } from '@/components/page';
import { ClaudeConnect, useClaudeState } from '@/components/settings/connect/ClaudeConnect';
import { ModelDefaults, type ModelChoice } from '@/components/settings/connect/ModelDefaults';
import {
  isPiModel,
  PiModelPicker,
  ProviderKeyForm,
  useSavePiModel,
} from '@/components/settings/connect/ProviderConnect';
import { t } from '@/i18n';
import { useProviders, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

export type EngineKind = 'claude' | 'pi';

/** A setup step: title and text, its content, and Back / Continue at the bottom. */
export function StepPage({
  title,
  body,
  children,
  onBack,
  next,
}: {
  title: string;
  body: string;
  children: ReactNode;
  onBack?: () => void;
  next: ReactNode;
}) {
  const c = useColors();
  return (
    <KeyboardAvoidingView style={styles.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.fill}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text style={[styles.title, { color: c.foreground }]} accessibilityRole="header">
          {title}
        </Text>
        <Text style={[styles.body, { color: c.mutedForeground }]}>{body}</Text>
        <View style={styles.children}>{children}</View>
      </ScrollView>
      <View style={[styles.footer, { borderColor: c.border }]}>
        {onBack ? <PillButton label={t('onboarding.back')} variant="ghost" onPress={onBack} /> : null}
        <View style={styles.spacer} />
        {next}
      </View>
    </KeyboardAvoidingView>
  );
}

/** Claude, or another provider's API key; either is enough for the bots to answer. */
export function AiStep({
  onBack,
  onNext,
}: {
  onBack?: () => void;
  onNext: (connected: EngineKind | null) => void;
}) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { connected: claudeOk } = useClaudeState();
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  const [picked, setPicked] = useState<EngineKind | null>(null);
  const kind = picked ?? (settings?.defaultEngine === 'pi' ? 'pi' : 'claude');
  const connected = kind === 'claude' ? claudeOk : providers.some((p) => p.configured);
  const options: { id: EngineKind; title: string; hint: string }[] = [
    { id: 'claude', title: t('ai.claude'), hint: t('ai.claudeHint') },
    { id: 'pi', title: t('ai.other'), hint: t('ai.otherHint') },
  ];
  // A fresh check on arrival: the status from boot may be old or never taken.
  const check = useMutation({
    mutationFn: api.checkClaude,
    onSettled: () => qc.invalidateQueries({ queryKey: ['info', origin] }),
  });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    check.mutate();
  }, [check]);
  return (
    <StepPage
      title={t('claude.title')}
      body={t('claude.body')}
      onBack={onBack}
      next={
        <PillButton
          label={connected ? t('onboarding.continue') : t('onboarding.later')}
          variant={connected ? 'primary' : 'secondary'}
          disabled={kind === 'claude' && check.isPending}
          onPress={() => onNext(connected ? kind : null)}
        />
      }
    >
      <View style={styles.options} accessibilityRole="radiogroup">
        {options.map((o) => {
          const on = kind === o.id;
          return (
            <Pressable
              key={o.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => setPicked(o.id)}
              style={[
                styles.option,
                {
                  borderColor: on ? `${c.brand}99` : c.border,
                  backgroundColor: on ? `${c.brand}1A` : 'transparent',
                },
              ]}
            >
              <Text style={[styles.optionTitle, { color: c.foreground }]}>{o.title}</Text>
              <Text style={[styles.optionHint, { color: c.mutedForeground }]}>{o.hint}</Text>
            </Pressable>
          );
        })}
      </View>
      {kind === 'claude' ? <ClaudeConnect checking={check.isPending} /> : <ProviderKeyForm />}
    </StepPage>
  );
}

export function ModelStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: settings } = useSettings();
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const value: ModelChoice = choice ?? {
    model: settings?.defaultModel ?? '',
    effort: settings?.effort ?? '',
  };
  const save = useMutation({
    mutationFn: () =>
      api.updateSettings({ defaultModel: value.model, effort: value.effort, defaultEngine: 'claude' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', origin] });
      onNext();
    },
    onError: toastError,
  });
  return (
    <StepPage
      title={t('model.title')}
      body={t('model.body')}
      onBack={onBack}
      next={
        <PillButton
          label={t('onboarding.continue')}
          variant="primary"
          busy={save.isPending}
          onPress={() => save.mutate()}
        />
      }
    >
      <ModelDefaults value={value} onChange={setChoice} />
    </StepPage>
  );
}

export function PiModelStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const c = useColors();
  const { data: settings } = useSettings();
  const [ref, setRef] = useState<string | null>(null);
  const value = ref ?? settings?.piModel ?? '';
  const { save, error } = useSavePiModel(onNext);
  return (
    <StepPage
      title={t('provider.modelTitle')}
      body={t('provider.modelBody')}
      onBack={onBack}
      next={
        <PillButton
          label={save.isPending ? t('claude.testing') : t('onboarding.continue')}
          variant="primary"
          busy={save.isPending}
          disabled={!isPiModel(value)}
          onPress={() => save.mutate(value)}
        />
      }
    >
      <PiModelPicker value={value} onChange={setRef} />
      {error ? (
        <Text style={[styles.error, { color: c.destructive }]}>
          {t('provider.failed', { detail: error })}
        </Text>
      ) : null}
    </StepPage>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 24, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '600', letterSpacing: -0.4 },
  body: { fontSize: 16, lineHeight: 22, marginTop: 8 },
  children: { marginTop: 24, gap: 12 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth * 2,
  },
  spacer: { flex: 1 },
  options: { gap: 8, marginBottom: 12 },
  option: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, gap: 2 },
  optionTitle: { fontSize: 17, fontWeight: '500' },
  optionHint: { fontSize: 15, lineHeight: 20 },
  error: { fontSize: 16, lineHeight: 22, marginTop: 12 },
});
