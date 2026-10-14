'use strict';

const COMMANDS = [
  { id: 'config', command: '/export terse', required: true },
  { id: 'neighbor', command: '/ip neighbor print detail without-paging', required: true },
  { id: 'bridgehost', command: '/interface bridge host print detail without-paging', required: false },
  { id: 'route', command: '/ip route print detail without-paging', required: false },
  { id: 'arp', command: '/ip arp print detail without-paging', required: false },
  { id: 'system', command: '/system resource print', required: false },
  { id: 'vlans', command: '/interface bridge vlan print detail without-paging', required: false },
  { id: 'interface', command: '/interface print detail without-paging', required: false },
  { id: 'ipaddr', command: '/ip address print detail without-paging', required: false },
  { id: 'ospf', command: '/routing ospf neighbor print detail without-paging', required: false },
];

const byId = new Map(COMMANDS.map((entry) => [entry.id, entry]));

function select(ids) {
  if (!ids) return COMMANDS.slice();
  const requested = String(ids).split(',').map((id) => id.trim()).filter(Boolean);
  const selected = requested.map((id) => byId.get(id));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`未知收集指令 ID：${unknown.join(', ')}`);
  if (!selected.length) throw new Error('至少要選擇一個收集指令');
  return selected;
}

module.exports = { COMMANDS, select };
