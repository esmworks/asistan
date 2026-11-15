import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { toastError } from '@/components/overlay';
import { PillButton } from '@/components/page';
import { t } from '@/i18n';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { AboutStep, EMPTY_ANSWERS, type Answers } from './About';
import { BotsStep } from './Bots';
import type { StarterId } from './profile';
import { AiStep, ModelStep, PiModelStep, type EngineKind } from './Steps';

type Step = 'ai' | 'model' | 'about' | 'bots';

/**
 * First run on an empty server: how Claude signs in (or another provider), the default model,
 * a few questions about the person, and the starter bots made from the answers. The language
 * and server steps of the web app are left out: the phone's own language is used and the server
 * was chosen before sign-in.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const c = useColors();
  const api = useApi();
  const [step, setStep] = useState<Step>('ai');
  const [engine, setEngine] = useState<EngineKind>('claude');
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  // Set once the questions were answered, so coming back from the bots shows the whole talk.
  const [answered, setAnswered] = useState(false);
  const [created] = useState(() => new Map<StarterId, string>());
  const skip = useMutation({
    mutationFn: () => api.updateSettings({ onboarded: true }),
    onSuccess: onDone,
    onError: toastError,
  });
  return (
    <SafeAreaView
      style={[styles.screen, { backgroundColor: c.background }]}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <View style={styles.header}>
        <PillButton
          label={t('onboarding.skip')}
          variant="ghost"
          busy={skip.isPending}
          onPress={() => skip.mutate()}
        />
      </View>
      {step === 'ai' ? (
        <AiStep
          onNext={(connected) => {
            if (connected) setEngine(connected);
            setStep(connected ? 'model' : 'about');
          }}
        />
      ) : null}
      {step === 'model' ? (
        engine === 'pi' ? (
          <PiModelStep onBack={() => setStep('ai')} onNext={() => setStep('about')} />
        ) : (
          <ModelStep onBack={() => setStep('ai')} onNext={() => setStep('about')} />
        )
      ) : null}
      {step === 'about' ? (
        <AboutStep
          answers={answers}
          resume={answered}
          onChange={setAnswers}
          onNext={() => {
            setAnswered(true);
            setStep('bots');
          }}
        />
      ) : null}
      {step === 'bots' ? (
        <BotsStep answers={answers} created={created} onBack={() => setStep('about')} onDone={onDone} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    height: 48,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: 12,
  },
});
