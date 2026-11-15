import type { Skill } from '@yumakbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { confirm, toastError } from '@/components/overlay';
import { IconButton, LabeledInput, PillButton, Row, Section } from '@/components/page';
import { BringIn } from './more/BringIn';
import { SkillForm, type SkillDraft } from './more/SkillForm';
import { parseSkillFile } from './more/skillText';
import { Hint, Pad, Rows } from './common/controls';
import { useSectionBack } from './common/sectionBack';
import { t } from '@/i18n';
import { useBots, useSkills } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';

/** Largest SKILL.md read from disk; a skill is instructions, not a document store. */
const MAX_FILE = 200_000;

/** The "skills" settings section's content: write or import skills, and choose which bots have each. */
export function SkillsSection() {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: skills = [], isPending } = useSkills();
  const { data: bots = [] } = useBots();
  const [editing, setEditing] = useState<Skill | 'new' | null>(null);
  const [draft, setDraft] = useState<SkillDraft | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [bringOpen, setBringOpen] = useState(false);
  const [link, setLink] = useState('');
  // What the person's other AI tools on the server's computer have; only on their own computer.
  const { data: found } = useQuery({ queryKey: ['setup-import', origin], queryFn: api.setupImport });
  const offered = found?.available && (found.skills.length > 0 || found.servers.length > 0);
  const fromLink = useMutation({
    mutationFn: api.fetchSkill,
    onSuccess: ({ text, name }) => {
      setDraft(parseSkillFile(text, name));
      setEditing('new');
      setLink('');
      setLinkOpen(false);
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeSkill(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', origin] }),
    onError: toastError,
  });

  const pickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ['text/markdown', 'text/plain', 'text/*', '*/*'],
        copyToCacheDirectory: true,
      });
      const a = res.assets?.[0];
      if (res.canceled || !a) return;
      if ((a.size ?? 0) > MAX_FILE) return void toastError(new Error(t('skills.fileTooLarge')));
      const text = await (await fetch(a.uri)).text();
      setDraft(parseSkillFile(text, a.name === 'SKILL.md' ? '' : a.name));
      setEditing('new');
    } catch (e) {
      toastError(e);
    }
  };

  useSectionBack(!!editing || bringOpen, () => {
    setEditing(null);
    setBringOpen(false);
  });
  if (editing) {
    return (
      <SkillForm
        skill={editing === 'new' ? null : editing}
        draft={editing === 'new' ? draft : null}
        onClose={() => setEditing(null)}
      />
    );
  }
  if (bringOpen && found) return <BringIn found={found} onClose={() => setBringOpen(false)} />;
  return (
    <>
      <Hint>{t('skills.intro')}</Hint>
      <View style={styles.buttons}>
        <PillButton
          variant="primary"
          icon="plus"
          label={t('skills.new')}
          onPress={() => {
            setDraft(null);
            setEditing('new');
          }}
        />
        <PillButton icon="file-text" label={t('skills.import')} onPress={() => void pickFile()} />
        <PillButton icon="link" label={t('skills.importLink')} onPress={() => setLinkOpen((v) => !v)} />
        {offered ? (
          <PillButton icon="download" label={t('skills.bringIn')} onPress={() => setBringOpen(true)} />
        ) : null}
      </View>
      {linkOpen ? (
        <View style={styles.link}>
          <LabeledInput
            label={t('skills.importLink')}
            value={link}
            onChangeText={setLink}
            placeholder={t('skills.linkPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            autoFocus
            returnKeyType="go"
            onSubmitEditing={() => link.trim() && fromLink.mutate(link.trim())}
          />
          <View style={styles.right}>
            <PillButton
              variant="primary"
              label={t('skills.linkFetch')}
              onPress={() => fromLink.mutate(link.trim())}
              busy={fromLink.isPending}
              disabled={!link.trim()}
            />
          </View>
        </View>
      ) : null}
      <Section>
        {!isPending && skills.length === 0 ? (
          <Pad>
            <Hint>{t('skills.empty')}</Hint>
          </Pad>
        ) : (
          <Rows>
            {skills.map((s) => {
              const holders = bots.filter((b) => s.botIds.includes(b.id));
              return (
                <Row
                  key={s.id}
                  label={s.name}
                  detail={`${s.description}${holders.length ? '' : `\n${t('skills.noBots')}`}`}
                  onPress={() => setEditing(s)}
                  chevron={false}
                  right={
                    <View style={styles.actions}>
                      {holders.slice(0, 3).map((b) => (
                        <Avatar key={b.id} name={b.name} color={b.color} avatar={b.avatar} size={22} />
                      ))}
                      <IconButton
                        icon="trash-2"
                        size={18}
                        label={t('common.delete')}
                        disabled={remove.isPending}
                        onPress={async () => {
                          if (
                            await confirm({
                              title: t('skills.confirmDelete', { name: s.name }),
                              destructive: true,
                              confirmLabel: t('common.delete'),
                            })
                          )
                            remove.mutate(s.id);
                        }}
                      />
                    </View>
                  }
                />
              );
            })}
          </Rows>
        )}
      </Section>
    </>
  );
}

const styles = StyleSheet.create({
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  link: { gap: 10 },
  right: { alignItems: 'flex-end' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
