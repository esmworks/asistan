import type { Bot } from '@yumakbot/shared';
import type { Ctx } from '../context';
import type { Engine } from '../engine/types';
import { TurnManager } from '../runtime/turns';
import { ToolFactory } from '../tools';
import { ApprovalService } from './approvals';
import { BotImportService } from './bot-import';
import { BotService } from './bots';
import { ClaudeAuthService } from './claude-auth';
import { ConnectionService } from './connections';
import { TelegramChannels } from '../channels/telegram';
import { WhatsAppChannel } from '../channels/whatsapp';
import { Inbox } from './inbox';
import { PageShareService } from './page-shares';
import { ApiCredentialService } from './api-credentials';
import { EmailService } from './email';
import { AiEndpointService } from './ai-endpoints';
import { EmbeddingService } from './embeddings';
import { TranscribeService } from './transcribe';
import { SpeechService } from './speech';
import { PluginService } from './plugins';
import { ApiSourceService } from './api-sources';
import { JobService } from './jobs';
import { MemoryService } from './memory';
import { PushService } from './push';
import { RoutineService } from './routines';
import { SubscriptionService } from './subscriptions';
import { ProviderKeyService } from './keys';
import { ImageService } from './images';
import { SkillService } from './skills';
import { ReactionNotifier } from './reactions';
import { RoomService } from './rooms';
import { SettingsService } from './settings';
import { ThreadService } from './threads';
import { UsageService } from './usage';
import { BotApi } from './bot-api';
import { VaultService } from './vault';

export class Services {
  readonly bots: BotService;
  readonly threads: ThreadService;
  readonly rooms: RoomService;
  readonly approvals: ApprovalService;
  readonly vault: VaultService;
  readonly claudeAuth: ClaudeAuthService;
  readonly connections: ConnectionService;
  readonly memory: MemoryService;
  readonly push: PushService;
  readonly settings: SettingsService;
  readonly botImport: BotImportService;
  readonly keys: ProviderKeyService;
  readonly images: ImageService;
  readonly skills: SkillService;
  readonly jobs: JobService;
  readonly routines: RoutineService;
  readonly subscriptions: SubscriptionService;
  readonly tools: ToolFactory;
  readonly turns: TurnManager;
  readonly reactions: ReactionNotifier;
  readonly usage: UsageService;
  readonly botApi: BotApi;
  readonly inbox: Inbox;
  readonly pageShares: PageShareService;
  readonly apiCredentials: ApiCredentialService;
  readonly email: EmailService;
  readonly ai: AiEndpointService;
  readonly embeddings: EmbeddingService;
  readonly transcribe: TranscribeService;
  readonly speech: SpeechService;
  readonly plugins: PluginService;
  readonly apiSources: ApiSourceService;
  readonly telegram: TelegramChannels;
  readonly whatsapp: WhatsAppChannel;

  constructor(
    readonly ctx: Ctx,
    engineFor: (bot: Bot) => Engine,
    clock?: () => Date,
    /**
     * Looks at permission requests of bots in the `review` mode, and at routine runs before they
     * start, whatever engine the bot runs on.
     */
    reviewer?: () => Engine,
  ) {
    this.bots = new BotService(ctx);
    this.threads = new ThreadService(ctx);
    this.rooms = new RoomService(ctx, this);
    this.vault = new VaultService(ctx);
    this.claudeAuth = new ClaudeAuthService(ctx, this.vault);
    this.connections = new ConnectionService(ctx, this.vault);
    this.approvals = new ApprovalService(ctx, this.vault);
    this.memory = new MemoryService(ctx);
    this.push = new PushService(ctx, this.vault);
    this.settings = new SettingsService(ctx);
    this.botImport = new BotImportService(ctx, this.settings);
    this.subscriptions = new SubscriptionService(ctx, this.vault);
    this.keys = new ProviderKeyService(ctx, this.vault, fetch, this.subscriptions);
    this.images = new ImageService(this.keys);
    this.skills = new SkillService(ctx);
    this.jobs = new JobService(ctx, this);
    this.routines = new RoutineService(ctx, this, clock, reviewer);
    this.tools = new ToolFactory(ctx, this);
    this.turns = new TurnManager(ctx, this, engineFor, reviewer);
    this.turns.onFinished((t, o) => this.jobs.onTurnFinished(t, o));
    this.turns.onFinished((t, o) => this.routines.onTurnFinished(t, o));
    this.turns.onFinished((t, o) => this.rooms.onTurnFinished(t, o));
    this.reactions = new ReactionNotifier(ctx, this);
    this.usage = new UsageService(ctx, this.settings, clock);
    this.botApi = new BotApi(ctx, this);
    this.inbox = new Inbox(ctx, this);
    this.pageShares = new PageShareService(ctx);
    this.apiCredentials = new ApiCredentialService(ctx, this.vault);
    this.email = new EmailService(ctx, this);
    this.ai = new AiEndpointService(ctx, this.vault);
    this.embeddings = new EmbeddingService(ctx, this.ai);
    this.memory.useEmbeddings(this.embeddings);
    this.transcribe = new TranscribeService(this.keys, this.ai);
    this.speech = new SpeechService(this.ai);
    this.plugins = new PluginService(this);
    this.apiSources = new ApiSourceService(ctx, this.apiCredentials);
    this.telegram = new TelegramChannels(ctx, this, this.vault);
    this.whatsapp = new WhatsAppChannel(ctx, this, this.vault);
  }
}
