/**
 * 会话行为设置块：思考过程留痕、帧编号与帧节奏（Telegram 专属）。
 *
 * 开启留痕后，机器人把 agent 的推理与工具调用作为独立的 💭/🔧 消息实时发出来，
 * 最终答案单独成条；关闭则回到「占位符被最终答案覆盖」的原有单消息行为。
 * 一轮里可能产生几十帧，所以另外两个设置决定这串消息的样子：编号让顺序可见，
 * 节奏把突发合并成最新一帧，而不是排一队过期的消息。
 */
import { normalizeThinkingIntervalSeconds } from '../../../../src/channels/shared/thinking-cadence.mjs';
import { h } from '../../i18n.js';
import * as React from 'react';

/** 0 表示不限制；其余是常见的步长，最大一分钟。 */
export const THINKING_INTERVAL_OPTIONS = Object.freeze([
  0, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60,
]);

/** 配置里可能存着列表外的值（旧配置或手工编辑），补一个选项而不是静默改成 0。 */
function intervalValues(saved) {
  if (THINKING_INTERVAL_OPTIONS.includes(saved)) return THINKING_INTERVAL_OPTIONS;
  return [...THINKING_INTERVAL_OPTIONS, saved].sort((left, right) => left - right);
}

export function ThinkingTracesSettings({
  account, busy, onSave, rpcCall, endpoints, onChanged,
}) {
  const checked = account.thinkingTraces !== false;
  const storedNumbering = account.thinkingNumbering === true;
  const storedInterval = normalizeThinkingIntervalSeconds(account.thinkingIntervalSeconds);
  // 两个新控件共用一个 RPC，所以各自提交时都要带上对方的当前值。
  const [draft, setDraft] = React.useState({
    thinkingNumbering: storedNumbering,
    thinkingIntervalSeconds: storedInterval,
  });
  // 另一个标签页保存过、或重连之后，服务端存的值才是准的。
  React.useEffect(() => {
    setDraft({ thinkingNumbering: storedNumbering, thinkingIntervalSeconds: storedInterval });
  }, [storedNumbering, storedInterval]);
  const [saving, setSaving] = React.useState(false);
  const endpoint = endpoints?.setThinkingCadence;
  const commit = async (patch) => {
    if (typeof rpcCall !== 'function' || !endpoint) return;
    const next = { ...draft, ...patch };
    setDraft(next);
    setSaving(true);
    try {
      const response = await rpcCall(endpoint, { botId: account.botId, ...next });
      if (response && response.ok === false) throw new Error(response.error?.message ?? '请求失败');
      await onChanged?.({ silent: true });
    } catch {
      // 服务端存的值仍然作准：界面回到它，免得显示一个没保存的节奏。
      setDraft({ thinkingNumbering: storedNumbering, thinkingIntervalSeconds: storedInterval });
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
    h('label', { className: 'dim-accountSettingsRow' },
      h('span', { className: 'dim-accountSettingsText' },
        h('span', { className: 'dim-accountSettingsLabel' }, '编号思考帧'),
        h('span', { className: 'dim-accountSettingsHelp' },
          '在每帧前加上本轮序号；被节奏跳过的帧也计数，所以编号会跳号（需先打开思考过程留痕）')),
      h('input', {
        type: 'checkbox',
        className: 'dim-accountSettingsSwitch',
        checked: draft.thinkingNumbering,
        disabled: Boolean(busy) || saving,
        onChange: (event) => { void commit({ thinkingNumbering: event.target.checked }); },
      })),
    h('label', { className: 'dim-accountSettingsRow' },
      h('span', { className: 'dim-accountSettingsText' },
        h('span', { className: 'dim-accountSettingsLabel' }, '最多每隔多久发送一帧（秒）'),
        h('span', { className: 'dim-accountSettingsHelp' },
          '突发时只发送窗口里最新的一帧，过期的帧丢弃，不排队也不重发')),
      h('select', {
        className: 'dim-accountSettingsSelect',
        value: String(draft.thinkingIntervalSeconds),
        disabled: Boolean(busy) || saving,
        onChange: (event) => {
          void commit({ thinkingIntervalSeconds: Number(event.target.value) });
        },
      }, intervalValues(draft.thinkingIntervalSeconds).map((value) => h('option', {
        key: value,
        value: String(value),
      }, value === 0 ? '不限制（0）' : String(value))))));
}
