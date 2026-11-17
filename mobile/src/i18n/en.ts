import type { OwnKey } from './tr';
import { en as sidebar } from './parts/sidebar';
import { en as chat } from './parts/chat';
import { en as message } from './parts/message';
import { en as panel } from './parts/panel';
import { en as dialogs } from './parts/dialogs';
import { en as settings } from './parts/settings';
import { en as apps } from './parts/apps';

export const en: Record<OwnKey, string> = {
  ...sidebar,
  ...chat,
  ...message,
  ...panel,
  ...dialogs,
  ...settings,
  ...apps,
  'common.retry': 'Try again',
  'common.ok': 'OK',

  'connect.title': 'Connect to your server',
  'connect.intro':
    'The bots run on your own server; this phone is only the window. Type the address of Yumak Bot on your computer or server.',
  'connect.url': 'Server address',
  'connect.urlPlaceholder': '192.168.1.20:4319',
  'connect.submit': 'Connect',
  'connect.invalid': 'This is not an address',
  'connect.notYumakBot': 'No Yumak Bot server answered at this address',
  'connect.httpsOnly':
    'No Yumak Bot server answered over HTTPS at this address. A server on the internet needs HTTPS; to use plain http anyway, type http:// in front.',
  'connect.insecureTitle': 'Connect without encryption?',
  'connect.insecureText':
    '{host} is on the internet but answers over plain http. Anyone on the way can read your access key, your password and your conversations. Use an https address unless you know why you need this.',
  'connect.insecureConfirm': 'Connect anyway',

  'offline.title': 'Could not reach the server',
  'offline.text':
    '{host} is not answering. Check that the server is on and that this phone is on the same network or VPN.',
  'offline.change': 'Other server',

  'login.key': 'Access key',
  'login.server': 'Server: {host}',

  'bots.logout': 'Sign out',
  'bots.loadFailed': 'Could not load the bots',

  'chat.back': 'Back',
  'chat.loadFailed': 'Could not load the conversation',
  'chat.sendFailed': 'Could not send the message',
};
