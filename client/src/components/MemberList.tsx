import { memberName, roleColor, useStore } from "../store";
import type { Member } from "../types";
import { openModal } from "../ui";
import { Avatar, BotTag } from "./common";
import { userMenu } from "./Sidebar";

export function MemberList({ guildId }: { guildId: string }) {
  const members = useStore((s) => s.members[guildId]);
  const roles = useStore((s) => s.roles[guildId]);
  const presences = useStore((s) => s.presences);
  const games = useStore((s) => s.games);
  const list = Object.values(members || {});
  const hoisted = [...(roles || [])].filter((r) => r.hoist && r.id !== guildId).sort((a, b) => b.position - a.position);

  const online = (m: Member) => m.user.is_bot || (presences[m.user.id] && presences[m.user.id] !== "offline");
  const byName = (a: Member, b: Member) => memberName(guildId, a.user).localeCompare(memberName(guildId, b.user));

  const groups: { title: string; items: Member[] }[] = [];
  const used = new Set<string>();
  for (const r of hoisted) {
    const items = list.filter((m) => !used.has(m.user.id) && online(m) && m.roles.includes(r.id)).sort(byName);
    items.forEach((m) => used.add(m.user.id));
    if (items.length) groups.push({ title: r.name, items });
  }
  const rest = list.filter((m) => !used.has(m.user.id) && online(m)).sort(byName);
  if (rest.length) groups.push({ title: "Online", items: rest });
  const offline = list.filter((m) => !online(m)).sort(byName);
  if (offline.length) groups.push({ title: "Offline", items: offline });

  return (
    <aside className="member-list">
      {groups.map((g) => (
        <div key={g.title}>
          <div className="member-group">
            {g.title} — {g.items.length}
          </div>
          {g.items.map((m) => (
            <div
              key={m.user.id}
              className={"member" + (online(m) ? "" : " offline")}
              onClick={() => openModal({ kind: "profile", userId: m.user.id, guildId })}
              onContextMenu={(e) => userMenu(e, m.user.id, guildId)}
            >
              <Avatar user={m.user} size={32} status />
              <div className="member-text">
                <span className="ellipsis" style={{ color: roleColor(guildId, m.user.id) }}>
                  {memberName(guildId, m.user)}
                </span>
                {games[m.user.id] && online(m) && (
                  <span className="playing ellipsis" title={`Playing ${games[m.user.id]}`}>
                    Playing <b className="ellipsis">{games[m.user.id]}</b>
                  </span>
                )}
              </div>
              {m.user.is_bot && <BotTag />}
            </div>
          ))}
        </div>
      ))}
    </aside>
  );
}
