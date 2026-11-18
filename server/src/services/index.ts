import type { Bot } from '@yumakbot/shared';
import type { Ctx } from '../context';
import type { Engine } from '../engine/types';
import { TurnManager } from '../runtime/turns';
import { ToolFactory } from '../tools';
import { AccessService } from './access';
import { ActionService } from './actions';
import { ApprovalService } from './approvals';
import { InstructionDocService } from './instruction-docs';
import { BotImportService } from './bot-import';
import { BotService } from './bots';
import { ClaudeAuthService } from './claude-auth';
import { ConnectionService } from './connections';
import { DiscordChannel } from '../channels/discord';
import { SlackChannel } from '../channels/slack';
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
import { TicketService } from './tickets';
import { TableService } from './tables';
import { ContentSealService } from './content-seal';
import { JobService } from './jobs';
import { MemoryService } from './memory';
import { MemoryReviewService } from './memory-review';
import { PushService } from './push';
import { RoutineService } from './routines';
import { SubscriptionService } from './subscriptions';
import { ProviderKeyService } from './keys';
import { ModelCatalogService } from './model-catalog';
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
  readonly access: AccessService;
  readonly bots: BotService;
  readonly threads: ThreadService;
  readonly rooms: RoomService;
  readonly approvals: ApprovalService;
  readonly actions: ActionService;
  readonly instructionDocs: InstructionDocService;
  readonly vault: VaultService;
  readonly claudeAuth: ClaudeAuthService;
  readonly connections: ConnectionService;
  readonly memory: MemoryService;
  readonly memoryReview: MemoryReviewService;
  readonly push: PushService;
  readonly settings: SettingsService;
  readonly botImport: BotImportService;
  readonly keys: ProviderKeyService;
  readonly modelCatalog: ModelCatalogService;
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
  readonly tickets: TicketService;
  readonly tables: TableService;
  readonly contentSeal: ContentSealService;
  readonly telegram: TelegramChannels;
  readonly whatsapp: WhatsAppChannel;
  readonly slack: SlackChannel;
  readonly discord: DiscordChannel;

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
    this.access = new AccessService(ctx);
    this.bots = new BotService(ctx);
    this.threads = new ThreadService(ctx);
    this.instructionDocs = new InstructionDocService(ctx, this.threads);
    this.rooms = new RoomService(ctx, this);
    this.vault = new VaultService(ctx);
    this.claudeAuth = new ClaudeAuthService(ctx, this.vault);
    this.connections = new ConnectionService(ctx, this.vault);
    this.approvals = new ApprovalService(ctx, this.vault);
    this.actions = new ActionService(ctx);
    this.memory = new MemoryService(ctx);
    this.push = new PushService(ctx, this.vault);
    this.settings = new SettingsService(ctx);
    this.botImport = new BotImportService(ctx, this.settings);
    this.subscriptions = new SubscriptionService(ctx, this.vault);
    this.modelCatalog = new ModelCatalogService(ctx, () => [
      ...this.keys.builtIn(),
      ...this.subscriptions.providers(),
    ]);
    this.keys = new ProviderKeyService(ctx, this.vault, fetch, this.subscriptions, this.modelCatalog);
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
    this.tickets = new TicketService(ctx, this);
    this.tables = new TableService(ctx);
    this.contentSeal = new ContentSealService(ctx);
    this.turns.onFinished((t, o) => this.tickets.onTurnFinished(t, o));
    this.memoryReview = new MemoryReviewService(ctx, this, engineFor);
    this.turns.onFinished((t, o) => this.memoryReview.onTurnFinished(t, o));
    this.threads.onContextReset((id) => this.memoryReview.onContextReset(id));
    this.telegram = new TelegramChannels(ctx, this, this.vault);
    this.whatsapp = new WhatsAppChannel(ctx, this, this.vault);
    this.slack = new SlackChannel(ctx, this, this.vault);
    this.discord = new DiscordChannel(ctx, this, this.vault);
  }
}
