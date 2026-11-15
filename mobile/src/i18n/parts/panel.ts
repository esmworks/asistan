/** Words only the phone app's panel screens use; the rest come from the web app's catalog. */
export const tr = {
  'panel.sched.hourly': 'Her saat :{minute}',
  'panel.sched.daily': 'Her gün {time}',
  'panel.sched.weekdays': 'Hafta içi {time}',
  'panel.sched.weekly': '{days} {time}',
  'panel.sched.monthly': 'Her ayın {day}. günü {time}',
  'panel.sched.once': '{date} {time} (bir kez)',
  'panel.sched.hours': '{count} saatte bir',
  'panel.sched.minutes': '{count} dakikada bir',
  'panel.sched.between': '{from}–{to} arası',
  'panel.sched.cron': 'Cron: {expr}',
  'panel.shareFailed': 'Dosya indirilemedi',
  'panel.loadFailed': 'Bot yüklenemedi',
  'panel.filesFailed': 'Dosyalar yüklenemedi',
  'preview.more': 'Diğer işlemler',
  'computer.desktopNoScreen':
    'Botun bilgisayarının canlı ekranı henüz telefonda gösterilemiyor. Ekranı bilgisayardaki uygulamadan izleyebilirsin.',
  'computer.unavailable': 'Bu sunucuda bota ait bir tarayıcı ya da bilgisayar yok.',
};

export const en: Record<keyof typeof tr, string> = {
  'panel.sched.hourly': 'Every hour at :{minute}',
  'panel.sched.daily': 'Every day at {time}',
  'panel.sched.weekdays': 'Weekdays at {time}',
  'panel.sched.weekly': '{days} at {time}',
  'panel.sched.monthly': 'Monthly on day {day} at {time}',
  'panel.sched.once': 'Once, on {date} at {time}',
  'panel.sched.hours': 'Every {count} hours',
  'panel.sched.minutes': 'Every {count} minutes',
  'panel.sched.between': 'between {from} and {to}',
  'panel.sched.cron': 'Cron: {expr}',
  'panel.shareFailed': 'The file could not be downloaded',
  'panel.loadFailed': 'The bot could not be loaded',
  'panel.filesFailed': 'The files could not be loaded',
  'preview.more': 'More actions',
  'computer.desktopNoScreen':
    "The live screen of the bot's computer cannot be shown on the phone yet. Watch it in the desktop app.",
  'computer.unavailable': 'This server has no browser or computer for the bot.',
};
