import type { BaseChannelAdapter } from '../channels/base.js';
import type { InboundMessage } from '../channels/types.js';
import type { SessionStateManager, VerboseLevel } from './session-state.js';
import type { ChannelRouter } from './router.js';
import type { QueryControls } from '../providers/base.js';
import type { ControlPanel } from './control-panel.js';
import type { ClaudeSettingSource } from '../config.js';
import type { ClaudeNativeSessionCandidate } from '../native/claude-native-scanner.js';
import { getBridgeContext } from '../context.js';
import { ClaudeSDKProvider } from '../providers/claude-sdk.js';
import { checkCodexAvailable } from '../providers/index.js';
import {
  findClaudeNativeSessionById,
  scanClaudeNativeSessions,
} from '../native/claude-native-scanner.js';
import {
  NativeSessionLeaseService,
  NATIVE_LEASE_TTL_MINUTES,
  maskLeaseOwner,
  nativeLeaseOwner,
} from '../native/native-session-lease.js';
import { renderRecentContextPages } from '../native/recent-context.js';
import { importClaudeNativeSession } from '../native/claude-session-importer.js';
import { NativeCommandCandidateCache } from './native-command-cache.js';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { ChannelBinding, NativeSessionLease, SessionData } from '../store/interface.js';

interface NativeCommandDeps {
  isChatActive?: (channelType: string, chatId: string) => boolean;
  scanNativeSessions?: () => Promise<ClaudeNativeSessionCandidate[]>;
  findNativeSessionById?: (sessionId: string) => Promise<ClaudeNativeSessionCandidate | null>;
  leaseService?: NativeSessionLeaseService;
  candidateCache?: NativeCommandCandidateCache;
}

const TELEGRAM_ONLY_NATIVE_COMMANDS = new Set([
  '/claude-sessions',
  '/cs',
  '/resume-claude',
  '/rc',
  '/release',
]);

const EMPTY_PREVIEW = '(empty)';

export class CommandRouter {
  private controlPanel?: ControlPanel;
  private readonly nativeDeps?: NativeCommandDeps;
  private readonly fallbackCandidateCache = new NativeCommandCandidateCache();

  constructor(
    private state: SessionStateManager,
    private getAdapters: () => Map<string, BaseChannelAdapter>,
    private router: ChannelRouter,
    private coreAvailable: () => boolean,
    private activeControls: Map<string, QueryControls>,
    private permissions: { clearSessionWhitelist(): void },
    private onNewSession?: (channelType: string, chatId: string) => void,
    nativeDeps?: NativeCommandDeps,
  ) {
    this.nativeDeps = nativeDeps;
  }

  private static MENU_HINT = '\n\n💡 Tip: Use /menu for the new control panel';

  /** Inject ControlPanel after construction (avoids circular deps) */
  setControlPanel(panel: ControlPanel): void {
    this.controlPanel = panel;
  }

  async handle(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const parts = this.tokenizeCommand(msg.text);
    const cmd = parts[0]?.toLowerCase() ?? '';

    if (TELEGRAM_ONLY_NATIVE_COMMANDS.has(cmd) && adapter.channelType !== 'telegram') {
      await adapter.send({
        chatId: msg.chatId,
        text: '⚠️ These Claude native session commands are available only in Telegram chats.',
      });
      return true;
    }

    if (adapter.channelType === 'telegram' && cmd.startsWith('/') && cmd !== '/release') {
      await this.refreshCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
    }

    switch (cmd) {
      case '/menu': {
        if (this.controlPanel) {
          await this.controlPanel.show(adapter, msg.chatId);
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Control panel not available' });
        }
        return true;
      }
      case '/status': {
        const ctx = getBridgeContext();
        const healthy = (ctx.core as { isHealthy?: () => boolean }).isHealthy?.() ?? false;
        const coreStatus = healthy ? '🟢 connected' : '🔴 disconnected';
        const channelList = Array.from(this.getAdapters().keys()).join(', ') || 'none';

        if (adapter.channelType === 'telegram') {
          const html = [
            `📡 <b>TLive Status</b>`,
            '',
            `<b>Bridge:</b>    🟢 running`,
            `<b>Core:</b>      ${coreStatus}`,
            `<b>Channels:</b>  <code>${channelList}</code>`,
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, html });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '📡 TLive Status',
              color: 0x3399FF,
              fields: [
                { name: 'Bridge', value: '🟢 Running', inline: true },
                { name: 'Core', value: coreStatus, inline: true },
                { name: 'Channels', value: `\`${channelList}\``, inline: true },
              ],
            },
          });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `**Bridge:** 🟢 running\n**Core:** ${coreStatus}\n**Channels:** ${channelList}`,
            feishuHeader: { template: 'blue', title: '📡 TLive Status' },
          });
        }
        return true;
      }
      case '/new': {
        if (this.isChatRunning(msg.channelType, msg.chatId)) {
          await adapter.send({
            chatId: msg.chatId,
            text: '⚠️ This chat is still running. Use /stop or wait for the current task to finish.',
          });
          return true;
        }

        await this.releaseCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
        this.getCandidateCache().clear(this.chatKey(msg.channelType, msg.chatId));

        this.onNewSession?.(msg.channelType, msg.chatId);
        const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
        this.state.clearLastActive(msg.channelType, msg.chatId);
        this.state.clearThread(msg.channelType, msg.chatId);
        this.permissions.clearSessionWhitelist();
        if (adapter.channelType === 'feishu') {
          await adapter.send({
            chatId: msg.chatId,
            text: 'Session cleared. Send a message to begin.',
            feishuHeader: { template: 'green', title: '🆕 New Session' },
          });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: { title: '🆕 New Session', description: 'Session cleared. Send a message to begin.', color: 0x00CC66 },
          });
        } else {
          await adapter.send({ chatId: msg.chatId, html: '🆕 <b>New session started.</b> Send a message to begin.' });
        }
        return true;
      }
      case '/verbose': {
        const level = parseInt(parts[1], 10) as VerboseLevel;
        if ([0, 1].includes(level)) {
          this.state.setVerboseLevel(msg.channelType, msg.chatId, level);
          const labels = ['🤫 quiet', '📝 terminal card'];
          const text = `Verbose: ${labels[level]}${CommandRouter.MENU_HINT}`;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: 0x3399FF } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        } else {
          const usage = 'Usage: `/verbose 0|1`\n0=quiet, 1=terminal card';
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: usage, color: 0x888888 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text: usage });
          }
        }
        return true;
      }
      case '/perm': {
        const sub = parts[1]?.toLowerCase();
        if (sub === 'on' || sub === 'off') {
          this.state.setPermMode(msg.channelType, msg.chatId, sub);
          const text = (sub === 'on'
            ? '🔐 Permission prompts: ON — dangerous tools will ask for confirmation'
            : '⚡ Permission prompts: OFF — all tools auto-allowed') + CommandRouter.MENU_HINT;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: sub === 'on' ? 0xFFA500 : 0x00CC00 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        } else {
          const current = this.state.getPermMode(msg.channelType, msg.chatId);
          const text = `🔐 Permission mode: **${current}**\nUsage: \`/perm on|off\`\non = prompt for dangerous tools (default)\noff = auto-allow all`;
          if (adapter.channelType === 'discord') {
            await adapter.send({ chatId: msg.chatId, embed: { description: text, color: 0x888888 } });
          } else {
            await adapter.send({ chatId: msg.chatId, text });
          }
        }
        return true;
      }
      case '/stop': {
        const chatKey = this.chatKey(msg.channelType, msg.chatId);
        const ctrl = this.activeControls.get(chatKey);
        if (ctrl) {
          this.activeControls.delete(chatKey);
          await ctrl.interrupt();
          await adapter.send({ chatId: msg.chatId, text: '⏹ Interrupted current execution' + CommandRouter.MENU_HINT });
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ No active execution to stop' });
        }
        await this.refreshCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
        return true;
      }
      case '/effort': {
        const LEVELS = ['low', 'medium', 'high', 'max'] as const;
        const level = parts[1]?.toLowerCase();
        if (level && LEVELS.includes(level as typeof LEVELS[number])) {
          this.state.setEffort(msg.channelType, msg.chatId, level as typeof LEVELS[number]);
          const icons: Record<string, string> = { low: '⚡', medium: '🧠', high: '💪', max: '🔥' };
          const text = `${icons[level] || '🧠'} Effort: **${level}**${CommandRouter.MENU_HINT}`;
          await adapter.send({ chatId: msg.chatId, text });
        } else {
          const current = this.state.getEffort(msg.channelType, msg.chatId) || 'default';
          const text = `🧠 Effort: **${current}**\nUsage: \`/effort low|medium|high|max\`\nlow = fast · medium = balanced · high = thorough · max = maximum`;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/hooks': {
        const pauseFile = join(homedir(), '.tlive', 'hooks-paused');
        const sub = parts[1]?.toLowerCase();
        if (sub === 'pause') {
          mkdirSync(dirname(pauseFile), { recursive: true });
          writeFileSync(pauseFile, '');
          await adapter.send({ chatId: msg.chatId, text: '⏸ Hooks paused — auto-allow, no notifications.' });
        } else if (sub === 'resume') {
          try { unlinkSync(pauseFile); } catch {}
          await adapter.send({ chatId: msg.chatId, text: '▶ Hooks resumed — forwarding to IM.' });
        } else {
          const paused = existsSync(pauseFile);
          await adapter.send({ chatId: msg.chatId, text: `Hooks: ${paused ? '⏸ paused' : '▶ active'}` });
        }
        return true;
      }
      case '/sessions': {
        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const binding = await this.router.resolve(msg.channelType, msg.chatId);
        const currentSessionId = binding?.sessionId;

        if (allSessions.length === 0) {
          await adapter.send({ chatId: msg.chatId, text: 'No sessions found.' });
          return true;
        }

        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        const lines: string[] = [];
        for (let i = 0; i < sorted.length; i++) {
          const s = sorted[i];
          const isCurrent = s.id === currentSessionId;
          const marker = isCurrent ? ' ◀' : '';
          const date = new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const msgs = await store.getMessages(s.id);
          const firstUser = msgs.find(m => m.role === 'user');
          const previewBase = firstUser?.content ?? s.nativePreview ?? EMPTY_PREVIEW;
          const preview = previewBase.length > 40 ? previewBase.slice(0, 37) + '...' : previewBase;
          const nativePrefix = s.source === 'claude-native' ? '[Claude native] ' : '';
          lines.push(`${i + 1}. ${date} — ${nativePrefix}${preview}${marker}`);
        }

        const footer = '\nUse /session <n> to switch';

        if (adapter.channelType === 'telegram') {
          await adapter.send({ chatId: msg.chatId, html: `<b>📋 Sessions</b>\n\n${lines.join('\n')}${footer}` });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '📋 Sessions',
              color: 0x3399FF,
              description: lines.join('\n') + footer,
            },
          });
        } else {
          await adapter.send({
            chatId: msg.chatId,
            text: `${lines.join('\n')}${footer}`,
            feishuHeader: { template: 'blue', title: '📋 Sessions' },
          });
        }
        return true;
      }
      case '/session': {
        const idx = parseInt(parts[1], 10);
        if (isNaN(idx) || idx < 1) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /session <number>\nUse /sessions to list.' });
          return true;
        }

        if (this.isChatRunning(msg.channelType, msg.chatId)) {
          await adapter.send({
            chatId: msg.chatId,
            text: '⚠️ This chat is still running. Use /stop or wait for the current task to finish.',
          });
          return true;
        }

        const { store } = getBridgeContext();
        const allSessions = await store.listSessions();
        const sorted = allSessions
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 10);

        if (idx > sorted.length) {
          await adapter.send({ chatId: msg.chatId, text: `Session ${idx} not found. Use /sessions to list.` });
          return true;
        }

        const target = sorted[idx - 1];
        await this.releaseCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
        this.getCandidateCache().clear(this.chatKey(msg.channelType, msg.chatId));
        await this.router.rebind(msg.channelType, msg.chatId, target.id);
        this.state.clearLastActive(msg.channelType, msg.chatId);

        const msgs = await store.getMessages(target.id);
        const firstUser = msgs.find(m => m.role === 'user');
        const previewBase = firstUser?.content ?? target.nativePreview ?? EMPTY_PREVIEW;
        const preview = previewBase.length > 50 ? previewBase.slice(0, 47) + '...' : previewBase;
        const hasContext = target.sdkSessionId ? '✅ has context' : '⚠️ no SDK session';
        await adapter.send({
          chatId: msg.chatId,
          text: `🔄 Switched to session ${idx}\n${preview}\n${hasContext}`,
        });
        return true;
      }
      case '/runtime': {
        const runtime = parts[1]?.toLowerCase();
        const RUNTIMES = ['claude', 'codex'] as const;
        if (runtime && RUNTIMES.includes(runtime as typeof RUNTIMES[number])) {
          if (runtime === 'codex' && this.isChatRunning(msg.channelType, msg.chatId)) {
            await adapter.send({
              chatId: msg.chatId,
              text: '⚠️ This chat is still running. Use /stop or wait for the current task to finish.',
            });
            return true;
          }

          if (runtime === 'codex' && !await checkCodexAvailable()) {
            await adapter.send({
              chatId: msg.chatId,
              text: '❌ Codex SDK not installed.\nRun: `npm install @openai/codex-sdk` in the bridge directory.',
            });
            return true;
          }

          if (runtime === 'codex') {
            await this.releaseCurrentNativeLeaseIfOwned(msg.channelType, msg.chatId);
            this.getCandidateCache().clear(this.chatKey(msg.channelType, msg.chatId));
          }

          const prevRuntime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
          this.state.setRuntime(msg.channelType, msg.chatId, runtime as 'claude' | 'codex');
          if (prevRuntime !== runtime) {
            const newSessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            await this.router.rebind(msg.channelType, msg.chatId, newSessionId);
            this.state.clearLastActive(msg.channelType, msg.chatId);
          }
          const icons: Record<string, string> = { claude: '🟣', codex: '🟢' };
          const text = `${icons[runtime] || '🔄'} Runtime: **${runtime}**`;
          await adapter.send({ chatId: msg.chatId, text });
        } else {
          const current = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
          const codexStatus = await checkCodexAvailable() ? '✅' : '❌ (not installed)';
          const text = `🔄 Runtime: **${current}**\nUsage: \`/runtime claude|codex\`\nclaude: ✅ · codex: ${codexStatus}`;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/model': {
        const model = parts.slice(1).join(' ').trim();
        if (model) {
          if (model === 'reset' || model === 'default') {
            this.state.setModel(msg.channelType, msg.chatId, undefined);
            await adapter.send({ chatId: msg.chatId, text: '🤖 Model: reset to default' + CommandRouter.MENU_HINT });
          } else {
            this.state.setModel(msg.channelType, msg.chatId, model);
            await adapter.send({ chatId: msg.chatId, text: `🤖 Model: **${model}**${CommandRouter.MENU_HINT}` });
          }
        } else {
          const current = this.state.getModel(msg.channelType, msg.chatId) || 'default';
          const text = `🤖 Model: **${current}**\nUsage: \`/model <name>\` or \`/model reset\`\nExamples: \`claude-sonnet-4-6\`, \`claude-opus-4-6\``;
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/settings': {
        const llm = getBridgeContext().llm;
        const arg = parts[1]?.toLowerCase();
        const runtime = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';

        if (runtime === 'codex' || !(llm instanceof ClaudeSDKProvider)) {
          const text = [
            '⚙️ **Codex Settings**',
            `  Model: \`${this.state.getModel(msg.channelType, msg.chatId) || 'default'}\``,
            `  Effort: \`${this.state.getEffort(msg.channelType, msg.chatId) || 'default'}\``,
            `  Perm: \`${this.state.getPermMode(msg.channelType, msg.chatId)}\``,
            '',
            'Use `/model`, `/effort`, `/perm` to change.',
            'Codex sandbox & network settings are set in config.',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, text });
          return true;
        }

        const PRESETS: Record<string, ClaudeSettingSource[]> = {
          user: ['user'],
          full: ['user', 'project', 'local'],
          isolated: [],
        };

        if (arg && arg in PRESETS) {
          llm.setSettingSources(PRESETS[arg]);
          const labels: Record<string, string> = {
            user: '👤 user — auth & model only',
            full: '📦 full — auth, CLAUDE.md, MCP, skills',
            isolated: '🔒 isolated — no external settings',
          };
          await adapter.send({ chatId: msg.chatId, text: `⚙️ Settings: ${labels[arg]}` });
        } else {
          const current = llm.getSettingSources();
          const preset = current.length === 0 ? 'isolated'
            : current.length === 1 && current[0] === 'user' ? 'user'
            : current.includes('project') ? 'full'
            : current.join(',');
          const text = [
            `⚙️ Settings: **${preset}** (${current.join(', ') || 'none'})`,
            'Usage: `/settings user|full|isolated`',
            '  user — ~/.claude/settings.json (auth, model)',
            '  full — + CLAUDE.md, MCP servers, skills',
            '  isolated — no external settings',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, text });
        }
        return true;
      }
      case '/claude-sessions':
      case '/cs': {
        return this.handleClaudeSessions(adapter, msg);
      }
      case '/resume-claude':
      case '/rc': {
        return this.handleResumeClaude(adapter, msg, parts);
      }
      case '/release': {
        return this.handleRelease(adapter, msg);
      }
      case '/help': {
        if (adapter.channelType === 'telegram') {
          const html = [
            '<b>❓ TLive Commands</b>',
            '',
            '<code>/menu</code> — ⚙️ <b>Control Panel</b> ✨',
            '<code>/new</code> — New conversation',
            '<code>/claude-sessions</code> · <code>/cs</code> — Claude native session list',
            '<code>/resume-claude &lt;n|current&gt;</code> · <code>/rc</code> — Resume Claude native session',
            '<code>/release</code> — Release Claude native lease',
            '',
            '<i>Legacy (use /menu instead):</i>',
            '<code>/sessions</code> · <code>/perm</code> · <code>/effort</code>',
            '<code>/model</code> · <code>/stop</code> · <code>/verbose</code>',
            '',
            '<code>/runtime claude|codex</code> — Switch AI provider',
            '<code>/settings user|full|isolated</code> — Claude settings scope',
            '<code>/hooks pause|resume</code> — Toggle IM approval',
            '<code>/status</code> — Bridge status',
            '<code>/approve &lt;code&gt;</code> — Approve pairing request',
            '<code>/help</code> — This message',
            '',
            '<i>💬 Reply <b>allow</b>/<b>deny</b> to approve permissions</i>',
          ].join('\n');
          await adapter.send({ chatId: msg.chatId, html });
        } else if (adapter.channelType === 'discord') {
          await adapter.send({
            chatId: msg.chatId,
            embed: {
              title: '❓ TLive Commands',
              color: 0x5865F2,
              description: [
                '`/menu` — **⚙️ Control Panel** ✨',
                '`/new` — New conversation',
                '',
                '*Legacy (use /menu instead):*',
                '`/sessions` · `/perm` · `/effort` · `/model` · `/stop` · `/verbose`',
                '',
                '`/runtime claude|codex` — Switch AI provider',
                '`/settings user|full|isolated` — Claude settings scope',
                '`/hooks pause|resume` — Toggle IM approval',
                '`/status` — Bridge status',
                '`/approve <code>` — Approve pairing request',
                '`/help` — This message',
                '',
                '*💬 Reply `allow`/`deny` to approve permissions*',
              ].join('\n'),
            },
          });
        } else {
          const feishuLines = [
            '/menu — ⚙️ **Control Panel** ✨',
            '/new — New conversation',
            '',
            '*Legacy (use /menu instead):*',
            '/sessions · /perm · /effort · /model · /stop · /verbose',
            '',
            '/runtime claude|codex — Switch AI provider',
            '/settings user|full|isolated — Claude settings scope',
            '/hooks pause|resume — Toggle IM approval',
            '/status — Bridge status',
            '/approve <code> — Approve pairing request',
            '/help — This message',
            '',
            '💬 回复 **allow** / **deny** 审批权限',
          ];
          await adapter.send({
            chatId: msg.chatId,
            text: feishuLines.join('\n'),
            feishuHeader: { template: 'indigo', title: '❓ TLive Commands' },
          });
        }
        return true;
      }
      case '/approve': {
        const code = parts[1];
        if (!code) {
          await adapter.send({ chatId: msg.chatId, text: 'Usage: /approve <pairing_code>' });
          return true;
        }
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'approvePairing' in tgAdapter) {
          const result = (tgAdapter as any).approvePairing(code);
          if (result) {
            await adapter.send({
              chatId: msg.chatId,
              text: `✅ Approved user ${result.username} (${result.userId})`,
            });
          } else {
            await adapter.send({ chatId: msg.chatId, text: '❌ Code not found or expired' });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Pairing not available' });
        }
        return true;
      }
      case '/pairings': {
        const tgAdapter = this.getAdapters().get('telegram');
        if (tgAdapter && 'listPairings' in tgAdapter) {
          const pairings = (tgAdapter as any).listPairings() as Array<{ code: string; userId: string; username: string }>;
          if (pairings.length === 0) {
            await adapter.send({ chatId: msg.chatId, text: 'No pending pairing requests.' });
          } else {
            const lines = pairings.map(p => `• <code>${p.code}</code> — ${p.username} (${p.userId})`);
            await adapter.send({
              chatId: msg.chatId,
              html: `<b>🔐 Pending Pairings</b>\n\n${lines.join('\n')}\n\nUse /approve <code> to approve.`,
            });
          }
        } else {
          await adapter.send({ chatId: msg.chatId, text: '⚠️ Pairing not available' });
        }
        return true;
      }
      default:
        return false;
    }
  }

  private tokenizeCommand(text: string): string[] {
    const matches = text.match(/"[^"]*"|\S+/g) ?? [];
    return matches.map(token => token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token);
  }

  private chatKey(channelType: string, chatId: string): string {
    return this.state.stateKey(channelType, chatId);
  }

  private isChatRunning(channelType: string, chatId: string): boolean {
    const chatKey = this.chatKey(channelType, chatId);
    return this.state.isProcessing(chatKey) || this.nativeDeps?.isChatActive?.(channelType, chatId) === true;
  }

  private getLeaseService(): NativeSessionLeaseService {
    return this.nativeDeps?.leaseService ?? new NativeSessionLeaseService(getBridgeContext().store);
  }

  private getCandidateCache(): NativeCommandCandidateCache {
    return this.nativeDeps?.candidateCache ?? this.fallbackCandidateCache;
  }

  private async getCurrentImportedBinding(channelType: string, chatId: string): Promise<{
    binding: ChannelBinding;
    session: SessionData;
  } | null> {
    const { store } = getBridgeContext();
    const binding = await store.getBinding(channelType, chatId);
    if (!binding) {
      return null;
    }

    const session = await store.getSession(binding.sessionId);
    if (!session || session.source !== 'claude-native' || !session.sdkSessionId) {
      return null;
    }

    return { binding, session };
  }

  private async refreshCurrentNativeLeaseIfOwned(channelType: string, chatId: string): Promise<void> {
    const current = await this.getCurrentImportedBinding(channelType, chatId);
    if (!current?.session.sdkSessionId) {
      return;
    }

    await this.getLeaseService().refresh(current.session.sdkSessionId, nativeLeaseOwner(channelType, chatId));
  }

  private async releaseCurrentNativeLeaseIfOwned(channelType: string, chatId: string): Promise<void> {
    const current = await this.getCurrentImportedBinding(channelType, chatId);
    if (!current?.session.sdkSessionId) {
      return;
    }

    await this.getLeaseService().release(current.session.sdkSessionId, nativeLeaseOwner(channelType, chatId));
  }

  private async handleClaudeSessions(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    const { store } = getBridgeContext();
    const leaseService = this.getLeaseService();
    const cache = this.getCandidateCache();
    const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
    const chatKey = this.chatKey(msg.channelType, msg.chatId);

    await leaseService.cleanupExpired();
    const scan = this.nativeDeps?.scanNativeSessions ?? scanClaudeNativeSessions;
    const scanned = (await scan()).slice(0, 10);
    cache.set(chatKey, scanned);

    if (scanned.length === 0) {
      await adapter.send({ chatId: msg.chatId, text: 'No Claude Code history sessions found.' });
      return true;
    }

    const importedSessionIds = new Set(
      (await store.listSessions())
        .filter(session => session.source === 'claude-native' && session.sdkSessionId)
        .map(session => session.sdkSessionId as string),
    );

    const lines: string[] = [];
    for (let i = 0; i < scanned.length; i += 1) {
      const candidate = scanned[i];
      const lease = await leaseService.getActive(candidate.sessionId);
      const markers = this.buildCandidateMarkers(candidate, lease, owner, importedSessionIds.has(candidate.sessionId));
      const displayId = basename(candidate.sourcePath) || this.shortSessionId(candidate.sessionId);
      const preview = candidate.nativePreview || candidate.preview || EMPTY_PREVIEW;
      const location = candidate.cwd ?? candidate.sourcePath;
      const date = this.formatShortDate(candidate.lastActivityAt);
      const markerSuffix = markers.length > 0 ? ` · <i>${this.escapeHtml(markers.join(' · '))}</i>` : '';
      lines.push(
        `${i + 1}. <code>${this.escapeHtml(displayId)}</code> · <code>${this.escapeHtml(this.shortSessionId(candidate.sessionId))}</code> · ${this.escapeHtml(date)}${markerSuffix}\n` +
        `   <code>${this.escapeHtml(location)}</code>\n` +
        `   ${this.escapeHtml(preview)}`,
      );
    }

    const html = [
      '<b>🟣 Claude Code history sessions</b>',
      '',
      lines.join('\n'),
      '',
      '<i>Use <code>/rc &lt;n&gt;</code> within 5 minutes to resume.</i>',
    ].join('\n');
    await adapter.send({ chatId: msg.chatId, html });
    return true;
  }

  private buildCandidateMarkers(
    candidate: ClaudeNativeSessionCandidate,
    lease: NativeSessionLease | null,
    owner: string,
    imported: boolean,
  ): string[] {
    const markers: string[] = [];

    if (lease) {
      markers.push(lease.owner === owner ? 'locked by you' : `locked ${maskLeaseOwner(lease.owner)}`);
    }

    if (!candidate.cwd || candidate.cwdSource === 'unknown') {
      markers.push('cwd unknown');
    } else if (!candidate.cwdExists) {
      markers.push('path missing');
    }

    if (imported) {
      markers.push('imported');
    }

    if (candidate.gitBranch) {
      markers.push(`branch ${candidate.gitBranch}`);
    }

    return markers;
  }

  private async handleResumeClaude(
    adapter: BaseChannelAdapter,
    msg: InboundMessage,
    parts: string[],
  ): Promise<boolean> {
    if (this.isChatRunning(msg.channelType, msg.chatId)) {
      await adapter.send({
        chatId: msg.chatId,
        text: '⚠️ This chat is still running. Use /stop or wait for the current task to finish.',
      });
      return true;
    }

    const parsed = this.parseResumeCommand(parts);
    if (parsed.error || !parsed.target) {
      await adapter.send({ chatId: msg.chatId, text: parsed.error ?? this.resumeUsage() });
      return true;
    }

    const { store, llm } = getBridgeContext();
    const leaseService = this.getLeaseService();
    const cache = this.getCandidateCache();
    const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
    const chatKey = this.chatKey(msg.channelType, msg.chatId);
    const currentImported = await this.getCurrentImportedBinding(msg.channelType, msg.chatId);

    let candidate: ClaudeNativeSessionCandidate | null = null;

    if (parsed.target.toLowerCase() === 'current') {
      candidate = await this.resolveCurrentCandidate(msg.channelType, msg.chatId);
      if (!candidate) {
        await adapter.send({ chatId: msg.chatId, text: '⚠️ This chat is not currently bound to an imported Claude native session.' });
        return true;
      }
    } else {
      if (/^\d+$/.test(parsed.target)) {
        const idx = Number(parsed.target);
        const cached = cache.get(chatKey);
        if (!cached || idx < 1 || idx > cached.length) {
          await adapter.send({
            chatId: msg.chatId,
            text: '⚠️ Cached Claude native session list is missing, expired, or invalid. Run /claude-sessions first.',
          });
          return true;
        }
        candidate = cached[idx - 1];
      } else {
        const finder = this.nativeDeps?.findNativeSessionById ?? findClaudeNativeSessionById;
        candidate = await finder(parsed.target);
        if (!candidate) {
          await adapter.send({
            chatId: msg.chatId,
            text: `⚠️ Claude native session ${parsed.target} was not found. Run /claude-sessions or check the session id.`,
          });
          return true;
        }
      }
    }

    const activeLease = await leaseService.getActive(candidate.sessionId);
    if (activeLease && activeLease.owner !== owner) {
      await adapter.send({
        chatId: msg.chatId,
        text: `⚠️ This Claude native session is locked ${maskLeaseOwner(activeLease.owner)}.`,
      });
      return true;
    }

    const cwdValidation = this.resolveResumeWorkingDirectory(candidate, parsed.cwdOverride);
    if (!cwdValidation.ok || !cwdValidation.cwd) {
      await adapter.send({ chatId: msg.chatId, text: cwdValidation.error ?? this.resumeUsage() });
      return true;
    }

    const importedSession = await importClaudeNativeSession(store, candidate, {
      cwdOverride: cwdValidation.cwd !== candidate.cwd ? cwdValidation.cwd : undefined,
    });
    const acquired = await leaseService.acquire({
      sdkSessionId: candidate.sessionId,
      owner,
      ownerUserId: msg.userId,
      tliveSessionId: importedSession.id,
    });

    if (acquired.status === 'blocked') {
      await adapter.send({
        chatId: msg.chatId,
        text: `⚠️ This Claude native session is locked ${maskLeaseOwner(acquired.lease.owner)}.`,
      });
      return true;
    }

    if (currentImported?.session.sdkSessionId
      && currentImported.session.sdkSessionId !== candidate.sessionId
      && currentImported.session.id === currentImported.binding.sessionId) {
      const previousLease = await leaseService.getActive(currentImported.session.sdkSessionId);
      if (previousLease?.owner === owner) {
        await leaseService.release(currentImported.session.sdkSessionId, owner);
      }
    }

    await this.router.rebind(msg.channelType, msg.chatId, importedSession.id);
    this.state.clearLastActive(msg.channelType, msg.chatId);
    this.state.clearThread(msg.channelType, msg.chatId);

    const runtimeBefore = this.state.getRuntime(msg.channelType, msg.chatId) || 'claude';
    const switchedToClaude = runtimeBefore !== 'claude';
    if (switchedToClaude) {
      this.state.setRuntime(msg.channelType, msg.chatId, 'claude');
    }

    cache.clear(chatKey);

    const html = this.buildResumeSuccessHtml({
      candidate,
      tliveSessionId: importedSession.id,
      cwd: cwdValidation.cwd,
      switchedToClaude,
      isolatedSettings: llm instanceof ClaudeSDKProvider && llm.getSettingSources().length === 0,
      permissionsOff: this.state.getPermMode(msg.channelType, msg.chatId) === 'off',
    });
    await adapter.send({ chatId: msg.chatId, html });

    const pages = renderRecentContextPages(candidate.recentMessages, {
      mode: 'current',
    });
    for (const page of pages) {
      await adapter.send({ chatId: msg.chatId, html: page });
    }

    return true;
  }

  private parseResumeCommand(parts: string[]): { target?: string; cwdOverride?: string; error?: string } {
    const target = parts[1];
    if (!target) {
      return { error: this.resumeUsage() };
    }

    let cwdOverride: string | undefined;
    for (let i = 2; i < parts.length; i += 1) {
      const part = parts[i];
      if (part !== '--cwd') {
        return { error: this.resumeUsage() };
      }
      const value = parts[i + 1];
      if (!value) {
        return { error: this.resumeUsage() };
      }
      cwdOverride = value;
      i += 1;
    }

    return { target, cwdOverride };
  }

  private resumeUsage(): string {
    return 'Usage: /rc <n|current> [--cwd "absolute path"]';
  }

  private resolveResumeWorkingDirectory(
    candidate: ClaudeNativeSessionCandidate,
    cwdOverride?: string,
  ): { ok: true; cwd: string } | { ok: false; error: string } {
    if (cwdOverride) {
      return this.validateDirectoryOverride(cwdOverride);
    }

    if (!candidate.cwd || candidate.cwdSource === 'unknown') {
      return { ok: false, error: '⚠️ This Claude native session has unknown working directory. Re-run with --cwd "absolute path".' };
    }

    if (!candidate.cwdExists) {
      return { ok: false, error: '⚠️ The original Claude native working directory no longer exists. Re-run with --cwd "absolute path".' };
    }

    return { ok: true, cwd: candidate.cwd };
  }

  private validateDirectoryOverride(cwdOverride: string): { ok: true; cwd: string } | { ok: false; error: string } {
    if (!isAbsolute(cwdOverride)) {
      return { ok: false, error: '⚠️ --cwd must be an absolute path.' };
    }

    if (!existsSync(cwdOverride)) {
      return { ok: false, error: '⚠️ --cwd path does not exist.' };
    }

    try {
      if (!statSync(cwdOverride).isDirectory()) {
        return { ok: false, error: '⚠️ --cwd must point to a directory.' };
      }
    } catch {
      return { ok: false, error: '⚠️ Failed to inspect the supplied --cwd path.' };
    }

    return { ok: true, cwd: cwdOverride };
  }

  private async resolveCurrentCandidate(channelType: string, chatId: string): Promise<ClaudeNativeSessionCandidate | null> {
    const current = await this.getCurrentImportedBinding(channelType, chatId);
    if (!current?.session.sdkSessionId) {
      return null;
    }

    const finder = this.nativeDeps?.findNativeSessionById ?? findClaudeNativeSessionById;
    const refreshed = await finder(current.session.sdkSessionId);
    if (refreshed) {
      return refreshed;
    }

    return {
      sessionId: current.session.sdkSessionId,
      sourcePath: current.session.sourcePath ?? '',
      cwd: current.session.workingDirectory || undefined,
      cwdSource: current.session.workingDirectory ? 'project-dir' : 'unknown',
      cwdExists: current.session.workingDirectory ? existsSync(current.session.workingDirectory) : false,
      lastActivityAt: current.session.lastNativeActivityAt ?? current.session.importedAt ?? current.session.createdAt,
      preview: current.session.nativePreview ?? EMPTY_PREVIEW,
      nativePreview: current.session.nativePreview ?? EMPTY_PREVIEW,
      recentMessages: [],
      isSidechain: false,
    };
  }

  private buildResumeSuccessHtml(params: {
    candidate: ClaudeNativeSessionCandidate;
    tliveSessionId: string;
    cwd: string;
    switchedToClaude: boolean;
    isolatedSettings: boolean;
    permissionsOff: boolean;
  }): string {
    const lines = [
      '🟣 <b>Claude native session resumed</b>',
      '',
      `<b>Session:</b> <code>${this.escapeHtml(this.shortSessionId(params.candidate.sessionId))}</code>`,
      `<b>TLive session:</b> <code>${this.escapeHtml(params.tliveSessionId)}</code>`,
      `<b>CWD:</b> <code>${this.escapeHtml(params.cwd)}</code>`,
      `<b>Resume on desktop:</b> <code>claude --resume ${this.escapeHtml(params.candidate.sessionId)}</code>`,
    ];

    if (params.candidate.gitBranch) {
      lines.push(`<b>Branch:</b> <code>${this.escapeHtml(params.candidate.gitBranch)}</code>`);
    }

    if (params.switchedToClaude) {
      lines.push('<b>Runtime:</b> switched to Claude');
    }

    if (params.isolatedSettings) {
      lines.push('⚠️ Claude settings scope is isolated; project settings, skills, and MCP servers are disabled.');
    }

    if (params.permissionsOff) {
      lines.push('⚠️ Permission prompts are OFF for this chat.');
    }

    lines.push(`<b>Lease:</b> ${NATIVE_LEASE_TTL_MINUTES}-minute TTL`);
    lines.push('Use <code>/release</code> when you are done.');
    lines.push('Do not type concurrently in Claude desktop while this lease is active.');

    return lines.join('\n');
  }

  private async handleRelease(adapter: BaseChannelAdapter, msg: InboundMessage): Promise<boolean> {
    if (this.isChatRunning(msg.channelType, msg.chatId)) {
      await adapter.send({
        chatId: msg.chatId,
        text: '⚠️ This chat is still running. Use /stop or wait for the current task to finish.',
      });
      return true;
    }

    const current = await this.getCurrentImportedBinding(msg.channelType, msg.chatId);
    if (!current?.session.sdkSessionId) {
      await adapter.send({
        chatId: msg.chatId,
        text: '⚠️ This chat is not currently bound to an imported Claude native session.',
      });
      return true;
    }

    const owner = nativeLeaseOwner(msg.channelType, msg.chatId);
    const result = await this.getLeaseService().release(current.session.sdkSessionId, owner);
    if (result.status === 'blocked') {
      await adapter.send({
        chatId: msg.chatId,
        text: `⚠️ This Claude native session is locked ${maskLeaseOwner(result.lease.owner)}.`,
      });
      return true;
    }

    this.onNewSession?.(msg.channelType, msg.chatId);
    this.getCandidateCache().clear(this.chatKey(msg.channelType, msg.chatId));

    const statusLine = result.status === 'released'
      ? '✅ Released Claude native lease and closed the local live session.'
      : result.status === 'expired'
        ? 'ℹ️ Claude native lease had already expired; local live session cleanup still ran.'
        : 'ℹ️ Claude native lease was already released or missing; local live session cleanup still ran.';
    const html = [
      `<b>${statusLine}</b>`,
      '',
      `<b>CWD:</b> <code>${this.escapeHtml(current.session.workingDirectory)}</code>`,
      `<b>Resume on desktop:</b> <code>claude --resume ${this.escapeHtml(current.session.sdkSessionId)}</code>`,
      'Desktop reminder: do not keep concurrent typing active after handing control back.',
    ].join('\n');
    await adapter.send({ chatId: msg.chatId, html });
    return true;
  }

  private shortSessionId(sessionId: string): string {
    return sessionId.length <= 8 ? sessionId : sessionId.slice(-8);
  }

  private formatShortDate(iso: string): string {
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) {
      return iso;
    }

    return value.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private escapeHtml(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }
}
