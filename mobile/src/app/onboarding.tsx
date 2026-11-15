import { useQueryClient } from '@tanstack/react-query';
import { Onboarding } from '@/components/onboarding/Onboarding';
import { nav } from '@/lib/nav';
import { useServer } from '@/lib/server';

/** First run: the setup questions, then the bots. */
export default function Screen() {
  const qc = useQueryClient();
  const { origin } = useServer();
  return (
    <Onboarding
      onDone={() => {
        void Promise.all([
          qc.invalidateQueries({ queryKey: ['settings', origin] }),
          qc.invalidateQueries({ queryKey: ['bots', origin] }),
        ]).then(() => nav.list());
      }}
    />
  );
}
