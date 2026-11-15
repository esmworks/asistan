import { USAGE_RANGES, type UsageRange, type UsageReport } from '@yumakbot/shared';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Loading, Note, PillButton, Row, Section, Segments } from '@/components/page';
import { shareFile } from '@/components/panel/files';
import { ChoiceRow, Pad, Rows, useSaveSettings } from './common/controls';
import { usd } from './more/money';
import { BotMark, DailyChart, ShareBar, UsageCard, UsageLine } from './more/usageParts';
import { t } from '@/i18n';
import { useBots, useSettings, useUsage } from '@/lib/queries';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** The bot filter's value for every bot; bot ids never take this form. */
const ALL = '*';

/** The "usage" settings section's content: a total, the cost per day, per bot, model and routine. */
export function UsageSection() {
  const c = useColors();
  const { origin } = useServer();
  const [days, setDays] = useState<UsageRange>(30);
  const [botId, setBotId] = useState<string | null>(null);
  const { data, isPending, isError } = useUsage(days, botId ?? undefined);
  const { data: bots = [] } = useBots();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <View>
        <Text style={[styles.small, { color: c.mutedForeground }]}>{t('usage.total')}</Text>
        <Text style={[styles.total, { color: c.foreground }]}>{data ? usd(data.total.costUsd) : '–'}</Text>
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {data ? t('usage.turnCount', { count: data.total.turns }) : ' '}
        </Text>
      </View>
      <Segments
        value={String(days)}
        onChange={(v) => setDays(Number(v) as UsageRange)}
        options={USAGE_RANGES.map((d) => ({ value: String(d), label: t(`usage.range.${d}`) }))}
      />
      <Section>
        <ChoiceRow
          icon="cpu"
          label={t('usage.botFilter')}
          value={botId ?? ALL}
          options={[
            { value: ALL, label: t('usage.allBots') },
            ...bots.map((b) => ({ value: b.id, label: b.name })),
          ]}
          onChange={(v) => setBotId(v === ALL ? null : v)}
        />
      </Section>
      {isPending ? (
        <Loading />
      ) : isError || !data ? (
        <Note>{t('usage.failed')}</Note>
      ) : (
        <Report data={data} filtered={botId !== null} onPickBot={setBotId} />
      )}
      <MonthLimit month={data?.month} />
      <PillButton
        icon="download"
        label={t('usage.downloadCsv')}
        busy={busy}
        onPress={async () => {
          setBusy(true);
          await shareFile(`${origin}/api/usage/turns.csv?days=${days}`, 'yumakbot-usage.csv');
          setBusy(false);
        }}
      />
    </>
  );
}

/** This month's spending against the limit, and the limit itself (empty or 0 for none). */
function MonthLimit({ month }: { month?: UsageReport['month'] }) {
  const c = useColors();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const limit = settings?.monthlyLimitUsd ?? 0;
  const value = draft ?? (limit ? String(limit) : '');
  const commit = () => {
    if (draft === null) return;
    const n = Number(draft.replace(',', '.'));
    setDraft(null);
    if (!Number.isFinite(n) || n < 0 || n === limit) return;
    save.mutate({ monthlyLimitUsd: Math.round(n * 100) / 100 });
  };
  const share = month && month.limitUsd > 0 ? Math.min(1, month.costUsd / month.limitUsd) : 0;
  return (
    <Section title={t('usage.month')}>
      <Rows>
        <Row
          label={month ? usd(month.costUsd) : '–'}
          detail={
            month && month.limitUsd > 0
              ? t('usage.monthOf', { limit: usd(month.limitUsd) })
              : t('usage.noLimit')
          }
          right={
            <View style={styles.limit}>
              <Text style={[styles.small, { color: c.mutedForeground }]}>{t('usage.limit')}</Text>
              <TextInput
                value={value}
                onChangeText={setDraft}
                onBlur={commit}
                onSubmitEditing={commit}
                keyboardType="decimal-pad"
                placeholder="0"
                placeholderTextColor={c.mutedForeground}
                accessibilityLabel={t('usage.limit')}
                style={[
                  styles.input,
                  { color: c.foreground, borderColor: c.border, backgroundColor: c.background },
                ]}
              />
            </View>
          }
        />
        {month && month.limitUsd > 0 ? (
          <Pad>
            <ShareBar share={share} color={share >= 1 ? c.destructive : share >= 0.8 ? c.amber : c.success} />
          </Pad>
        ) : null}
      </Rows>
    </Section>
  );
}

function Report({
  data,
  filtered,
  onPickBot,
}: {
  data: UsageReport;
  filtered: boolean;
  onPickBot: (botId: string) => void;
}) {
  const { data: bots = [] } = useBots();
  const byId = new Map(bots.map((b) => [b.id, b]));
  const share = (cost: number) => (data.total.costUsd > 0 ? cost / data.total.costUsd : 0);
  return (
    <>
      <Section title={t('usage.daily')}>
        <Pad>
          <DailyChart daily={data.daily} />
        </Pad>
      </Section>
      {!filtered ? (
        <UsageCard title={t('usage.bots')} empty={data.bots.length === 0}>
          {data.bots.map((b) => {
            const bot = byId.get(b.botId);
            return (
              <UsageLine
                key={b.botId}
                lead={<BotMark name={b.name || '–'} color={bot?.color} avatar={bot?.avatar} />}
                name={b.name || '–'}
                note={b.archived ? t('usage.archived') : null}
                turns={b.turns}
                cost={b.costUsd}
                share={share(b.costUsd)}
                onPress={() => onPickBot(b.botId)}
              />
            );
          })}
        </UsageCard>
      ) : null}
      <UsageCard title={t('usage.models')} empty={data.models.length === 0}>
        {data.models.map((m) => (
          <UsageLine
            key={`${m.engine}:${m.model}`}
            name={m.model || (m.engine ? t('usage.defaultModel') : t('usage.unknownModel'))}
            note={m.engine ? t(`bot.engine.${m.engine}`) : null}
            turns={m.turns}
            cost={m.costUsd}
            share={share(m.costUsd)}
          />
        ))}
      </UsageCard>
      {data.routines?.length ? (
        <UsageCard title={t('usage.routines')} empty={false}>
          {data.routines.map((r) => {
            const bot = r.botId ? byId.get(r.botId) : undefined;
            return (
              <UsageLine
                key={r.routineId}
                name={r.name}
                note={bot && !filtered ? bot.name : null}
                turns={r.turns}
                cost={r.costUsd}
                share={share(r.costUsd)}
              />
            );
          })}
        </UsageCard>
      ) : null}
      <View style={styles.notes}>
        <Note>{t('usage.estimate')}</Note>
        {data.total.unpriced > 0 ? <Note>{t('usage.unpriced', { count: data.total.unpriced })}</Note> : null}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  small: { fontSize: 13 },
  total: { fontSize: 32, fontWeight: '600', fontVariant: ['tabular-nums'] },
  limit: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    width: 84,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 15,
    textAlign: 'right',
  },
  notes: { gap: 4 },
});
