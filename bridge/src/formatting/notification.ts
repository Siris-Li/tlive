import type { ChannelType, OutboundMessage } from '../channels/types.js';
import type { NotificationData } from './types.js';
import { markdownToTelegram } from '../markdown/telegram.js';
import { downgradeHeadings } from '../markdown/feishu.js';

interface NotificationMessage {
  text?: string;
  html?: string;
  embed?: OutboundMessage['embed'];
  buttons?: OutboundMessage['buttons'];
  feishuHeader?: { template: string; title: string };
  /** Feishu Card 2.0: structured elements for richer layout */
  feishuElements?: Array<Record<string, unknown>>;
}

const COLOR_MAP: Record<NotificationData['type'], number> = {
  stop: 0x00CC66,       // green
  idle_prompt: 0x3399FF, // blue
  generic: 0x888888,     // gray
  external: 0x3399FF,    // blue
};

const HEADER_MAP: Record<NotificationData['type'], string> = {
  stop: 'green',
  idle_prompt: 'yellow',
  generic: 'blue',
  external: 'blue',
};

const EMOJI_MAP: Record<NotificationData['type'], string> = {
  stop: '✅',
  idle_prompt: '⏳',
  generic: '📢',
  external: '📢',
};

function truncateSummary(s: string, max = 3000): string {
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function externalSeverityTemplate(severity?: string): string {
  switch ((severity || '').toLowerCase()) {
    case 'error':
    case 'critical':
      return 'red';
    case 'warning':
    case 'warn':
      return 'orange';
    case 'success':
      return 'green';
    default:
      return HEADER_MAP.external;
  }
}

function externalSeverityColor(severity?: string): number {
  switch ((severity || '').toLowerCase()) {
    case 'error':
    case 'critical':
      return 0xCC3333;
    case 'warning':
    case 'warn':
      return 0xFFA500;
    case 'success':
      return 0x00CC66;
    default:
      return COLOR_MAP.external;
  }
}

function externalTelegramHtml(data: NotificationData, summary?: string): NotificationMessage {
  const parts = [`<b>${EMOJI_MAP.external} ${escapeHtml(data.title)}</b>`];
  if (data.source) parts.push(`<b>Source:</b> ${escapeHtml(data.source)}`);
  if (data.severity) parts.push(`<b>Severity:</b> ${escapeHtml(data.severity)}`);
  if (summary) parts.push(escapeHtml(summary));
  return { html: parts.join('\n\n') };
}

export function formatNotification(data: NotificationData, channelType: ChannelType): NotificationMessage {
  const summary = data.summary ? truncateSummary(data.summary) : undefined;
  const emoji = EMOJI_MAP[data.type];

  switch (channelType) {
    case 'telegram': {
      if (data.type === 'external') {
        return externalTelegramHtml(data, summary);
      }

      // Build everything as markdown, then convert to Telegram HTML in one pass
      const mdParts = [`**${emoji} ${data.title}**`];
      if (summary) mdParts.push('', summary.slice(0, 3000));
      const result: NotificationMessage = {};
      if (data.terminalUrl) {
        const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/.test(data.terminalUrl);
        if (isLocalhost) {
          // localhost: Telegram URL buttons reject localhost, use inline markdown link
          mdParts.push('', `🔗 [Open Terminal](${data.terminalUrl})`);
        } else {
          // Public domain: use URL inline button (works with both http and https)
          result.buttons = [{ label: '🔗 Open Terminal', callbackData: '_', url: data.terminalUrl }];
        }
      }
      result.html = markdownToTelegram(mdParts.join('\n'));
      return result;
    }

    case 'discord': {
      const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
      if (data.source) {
        fields.push({ name: 'Source', value: data.source, inline: true });
      }
      if (data.severity) {
        fields.push({ name: 'Severity', value: data.severity, inline: true });
      }
      if (data.terminalUrl) {
        fields.push({ name: '🔗 Terminal', value: `[Open Terminal](${data.terminalUrl})`, inline: true });
      }
      return {
        embed: {
          title: `${emoji} ${data.title}`,
          color: data.type === 'external' ? externalSeverityColor(data.severity) : COLOR_MAP[data.type],
          description: summary
            ? (summary.length > 500
              ? `\`\`\`\n${summary.slice(0, 497)}...\n\`\`\``
              : `\`\`\`\n${summary}\n\`\`\``)
            : undefined,
          fields: fields.length > 0 ? fields : undefined,
          footer: new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit' }),
        },
      };
    }

    case 'feishu': {
      const elements: Array<Record<string, unknown>> = [];
      if (data.source || data.severity) {
        const meta = [
          data.source ? `**Source:** ${data.source}` : '',
          data.severity ? `**Severity:** ${data.severity}` : '',
        ].filter(Boolean).join('\n');
        elements.push({ tag: 'markdown', content: meta });
      }
      if (summary) {
        // Downgrade ## headings to bold — Card renders headings too large
        elements.push({ tag: 'markdown', content: downgradeHeadings(summary) });
      }
      if (data.terminalUrl) {
        elements.push({ tag: 'hr' });
        elements.push({
          tag: 'markdown',
          content: `<font color='grey'>🔗 [Open Terminal](${data.terminalUrl})</font>`,
        });
      }
      return {
        text: summary || '',
        feishuHeader: {
          template: data.type === 'external' ? externalSeverityTemplate(data.severity) : HEADER_MAP[data.type],
          title: data.title ? `${emoji} ${data.title}` : emoji,
        },
        feishuElements: elements,
      };
    }
  }
}
