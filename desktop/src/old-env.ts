// Imported first by the entry module, so every module after it sees the old `YUMAKBOT_*` settings
// under their new names (see `adoptOldEnv`).
import { adoptOldEnv } from '@leafbot/shared';

adoptOldEnv(process.env);
