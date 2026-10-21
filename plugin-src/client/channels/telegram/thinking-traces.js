/**
 * 会话行为设置块：思考过程留痕开关与消息发送上限（Telegram 专属）。
 *
 * 开启留痕后，机器人把 agent 的推理与工具调用作为独立的 💭/🔧 消息实时发出来，
 * 最终答案单独成条；关闭则回到「占位符被最终答案覆盖」的原有单消息行为。
 * 发送上限对应 Telegram 对每个聊天的消息配额：配额用尽时机器人等待下一个空位，
 * 而不是丢弃消息。
 */
import { DEFAULT_SEND_LIMIT_PER_MINUTE } from '../../../../src/channels/shared/send-limit.mjs';
import { h } from '../../i18n.js';
import * as React from 'react';

function SendLimitField({ account, busy, saving, onCommit }) {
  const saved = Number.isInteger(account.sendLimitPerMinute)
    ? account.sendLimitPerMinute
    : DEFAULT_SEND_LIMIT_PER_MINUTE;
  const [value, setValue] = React.useState(String(saved));
  // A save from another tab, or a reconnect, rewrites the stored value.
  React.useEffect(() => { setValue(String(saved)); }, [saved]);
  const commit = () => {
    const numeric = Number(value.trim());
    if (!value.trim() || !Number.isFinite(numeric) || Math.round(numeric) === saved) {
      setValue(String(saved));
      return;
    }
    onCommit?.(Math.round(numeric));
  };
  return h('label', { className: 'dim-accountSettingsRow' },
    h('span', { className: 'dim-accountSettingsText' },
      h('span', { className: 'dim-accountSettingsLabel' }, '消息发送上限'),
      h('span', { className: 'dim-accountSettingsHelp' },
        '每个聊天每分钟的消息数；机器人会等待而不是丢弃')),
    h('input', {
      type: 'number',
      min: 1,
      max: 30,
      step: 1,
      className: 'dim-accountSettingsNumber',
      value,
      disabled: Boolean(busy) || saving,
      onChange: (event) => { setValue(event.target.value); },
      onBlur: commit,
      onKeyDown: (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        commit();
      },
    }));
}

export function ThinkingTracesSettings({
  account, busy, onSave, rpcCall, endpoints, onChanged,
}) {
  const checked = account.thinkingTraces !== false;
  const [saving, setSaving] = React.useState(false);
  const endpoint = endpoints?.setSendLimit;
  const commitSendLimit = async (sendLimitPerMinute) => {
    if (typeof rpcCall !== 'function' || !endpoint) return;
    setSaving(true);
    try {
      const response = await rpcCall(endpoint, { botId: account.botId, sendLimitPerMinute });
      if (response && response.ok === false) throw new Error(response.error?.message ?? '请求失败');
      await onChanged?.({ silent: true });
    } catch {
      // The stored value stays authoritative; the next reload shows it again.
    } finally {
      setSaving(false);
    }
  };
  return h('div', { className: 'dim-accountSettings' },
    h('h4', { className: 'dim-accountSettingsTitle' }, '会话行为'),
    h('label', { className: 'dim-accountSettingsRow' },
      h('span', { className: 'dim-accountSettingsText' },
        h('span', { className: 'dim-accountSettingsLabel' }, '思考过程留痕'),
        h('span', { className: 'dim-accountSettingsHelp' },
          '实时显示思考步骤与工具调用，最终答案单独成条')),
      h('input', {
        type: 'checkbox',
        className: 'dim-accountSettingsSwitch',
        checked,
        disabled: Boolean(busy),
        onChange: (event) => { onSave?.({ thinkingTraces: event.target.checked }); },
      })),
    h(SendLimitField, {
      account,
      busy: Boolean(busy),
      saving,
      onCommit: commitSendLimit,
    }));
}
