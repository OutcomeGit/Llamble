// Friends and parties (server: server/src/api/social.rs).
//
// Friends: ask by username, they accept; you see who's on and what they're playing.
// Parties: a small named group with its own chat and voice room, outside any server — like a
// mini server with nothing to set up. Each has its own button in the left bar.
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  currentChannelId,
  homeOf,
  isUnread,
  openFriend,
  openGuildView,
  selectChannel,
  useStore,
} from "../store";
import type { Channel, Friend, User } from "../types";
import { closeModal, openMenu, openModal, toast } from "../ui";
import { joinVoice, useVoice } from "../voice";
import { ChatView } from "./ChatView";
import { Avatar, Icon } from "./common";
import { VoiceView } from "./VoiceView";
import { ProfileCard, useProfile } from "./Profile";

const PARTY_MAX = 25;

async function message(userId: string) {
  try {
    const dm = await api("/api/users/@me/channels", {
      body: { recipient_id: userId },
    });
    selectChannel("@me", dm.id);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

/** Friends, in the left panel: requests, who's on, everyone else, and an add box. */
export function FriendsSidebar() {
  const friends = useStore((s) => s.friends);
  const users = useStore((s) => s.users);
  const presences = useStore((s) => s.presences);
  const games = useStore((s) => s.games);
  const selected = useStore((s) => s.selectedFriend);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const all = Object.values(friends).map((f) => ({
      ...f,
      user: { ...f.user, ...users[f.user.id] },
    }));
    const byName = (a: Friend, b: Friend) =>
      (a.user.display_name || a.user.username).localeCompare(
        b.user.display_name || b.user.username,
      );
    const fr = all.filter((f) => f.state === "friend").sort(byName);
    const on = (f: Friend) => (presences[f.user.id] || "offline") !== "offline";
    return {
      requests: all
        .filter((f) => f.state !== "friend")
        .sort((a, b) =>
          a.state === b.state
            ? b.since - a.since
            : a.state === "incoming"
              ? -1
              : 1,
        ),
      online: fr.filter(on),
      offline: fr.filter((f) => !on(f)),
    };
  }, [friends, users, presences]);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const f: Friend = await api("/api/friends", {
        body: { username: name.trim() },
      });
      toast(
        f.state === "friend"
          ? `You and ${f.user.display_name} are friends now`
          : `Friend request sent to ${f.user.display_name}`,
      );
      setName("");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const row = (f: Friend) => (
    <FriendRow
      key={f.user.id}
      f={f}
      active={selected === f.user.id}
      status={presences[f.user.id] || "offline"}
      game={games[f.user.id]}
    />
  );
  return (
    <>
      <div className="sidebar-header static">Friends</div>
      <form
        className="friends-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add by username"
          maxLength={40}
        />
        <button
          className="icon-btn"
          title="Send friend request"
          disabled={busy || !name.trim()}
        >
          <Icon name="plus" size={18} />
        </button>
      </form>
      <div className="channel-scroll">
        {groups.requests.length > 0 && (
          <div className="dm-section">Requests — {groups.requests.length}</div>
        )}
        {groups.requests.map(row)}
        <div className="dm-section">Online — {groups.online.length}</div>
        {groups.online.map(row)}
        {groups.online.length === 0 && (
          <p className="muted small pad">
            None of your friends are on right now.
          </p>
        )}
        {groups.offline.length > 0 && (
          <div className="dm-section">Offline — {groups.offline.length}</div>
        )}
        {groups.offline.map(row)}
        {Object.keys(friends).length === 0 && (
          <p className="muted small pad">
            No friends yet. Type someone's username above to send a request.
          </p>
        )}
      </div>
    </>
  );
}

function FriendRow({
  f,
  active,
  status,
  game,
}: {
  f: Friend;
  active: boolean;
  status: string;
  game?: string;
}) {
  const sub =
    f.state === "incoming"
      ? "Wants to be friends"
      : f.state === "outgoing"
        ? "Request sent"
        : game && status !== "offline"
          ? `Playing ${game}`
          : status === "offline"
            ? "Offline"
            : status === "dnd"
              ? "Do not disturb"
              : status === "idle"
                ? "Away"
                : "Online";
  return (
    <div
      className={"dm-row" + (active ? " active" : "")}
      onClick={() => openFriend(f.user.id)}
      onContextMenu={(e) => openMenu(e, friendMenu(f))}
    >
      <Avatar user={f.user} size={32} status={f.state === "friend"} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{f.user.display_name}</div>
        <div
          className={
            "small ellipsis " +
            (game && f.state === "friend" && status !== "offline"
              ? "playing-line"
              : "muted")
          }
        >
          {sub}
        </div>
      </div>
      {f.state === "incoming" && (
        <span className="row gap-s" onClick={(e) => e.stopPropagation()}>
          <button
            className="icon-btn green"
            title="Accept"
            onClick={() => accept(f)}
          >
            ✓
          </button>
          <button
            className="icon-btn"
            title="Decline"
            onClick={() => removeFriend(f, "Request declined")}
          >
            <Icon name="x" size={16} />
          </button>
        </span>
      )}
    </div>
  );
}

const accept = (f: Friend) =>
  api(`/api/friends/${f.user.id}`, { method: "PUT" }).catch((e) =>
    toast(e.message, "error"),
  );
const removeFriend = (f: Friend, what: string) =>
  api(`/api/friends/${f.user.id}`, { method: "DELETE" })
    .then(() => {
      toast(what);
      if (useStore.getState().selectedFriend === f.user.id)
        useStore.setState({ selectedFriend: null });
    })
    .catch((e) => toast(e.message, "error"));

function friendMenu(f: Friend) {
  if (f.state === "incoming")
    return [
      { label: "Accept", onClick: () => accept(f) },
      {
        label: "Decline",
        danger: true,
        onClick: () => removeFriend(f, "Request declined"),
      },
    ];
  if (f.state === "outgoing")
    return [
      {
        label: "Cancel request",
        danger: true,
        onClick: () => removeFriend(f, "Request cancelled"),
      },
    ];
  return [
    { label: "Message", onClick: () => message(f.user.id) },
    { label: "Call", onClick: () => call(f.user.id) },
    {
      label: "Start a party with them",
      onClick: () => openModal({ kind: "party", with: [f.user.id] }),
    },
    { separator: true, label: "" },
    {
      label: `Remove ${f.user.display_name}`,
      danger: true,
      onClick: () => confirmRemove(f),
    },
  ];
}

const confirmRemove = (f: Friend) =>
  openModal({
    kind: "confirm",
    title: "Remove friend",
    body: `Remove ${f.user.display_name} from your friends?`,
    danger: true,
    confirmLabel: "Remove",
    onConfirm: () => removeFriend(f, "Removed"),
  });

async function call(userId: string) {
  try {
    const dm = await api("/api/users/@me/channels", {
      body: { recipient_id: userId },
    });
    selectChannel("@me", dm.id);
    joinVoice(dm.id);
    api(`/api/channels/${dm.id}/ring`, { method: "POST" }).catch(() => {});
  } catch (e: any) {
    toast(e.message, "error");
  }
}

/** A friend's page in the main window (or a hello when nobody's picked). */
export function FriendProfile() {
  const id = useStore((s) => s.selectedFriend);
  const f = useStore((s) => (id ? s.friends[id] : undefined));
  const live = useStore((s) => (id ? s.users[id] : undefined));
  const status = useStore((s) =>
    id ? s.presences[id] || "offline" : "offline",
  );
  const game = useStore((s) => (id ? s.games[id] : undefined));
  const voiceCh = useStore((s) =>
    id && s.voiceStates[id]
      ? s.channels[s.voiceStates[id].channel_id]
      : undefined,
  );
  const voiceGuild = useStore((s) =>
    voiceCh?.guild_id ? s.guilds[voiceCh.guild_id] : undefined,
  );
  const channels = useStore((s) => s.channels);
  const guilds = useStore((s) => s.guilds);
  const inMyCall = useVoice((v) => !!voiceCh && v.channelId === voiceCh.id);
  const [mutual, setMutual] = useState<string[]>([]);
  const profile = useProfile(f ? id : null);
  const [note, setNote] = useState("");
  useEffect(() => {
    setNote(f?.note ?? "");
  }, [id, f?.note]);
  useEffect(() => {
    setMutual([]);
    if (!id || f?.state !== "friend") return;
    let gone = false;
    api(`/api/friends/${id}`)
      .then((v) => !gone && setMutual(v.mutual_guilds || []))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [id, f?.state]);
  const parties = useMemo(
    () =>
      Object.values(channels).filter(
        (c) => c.kind === "party" && c.recipients?.some((r) => r.id === id),
      ),
    [channels, id],
  );

  if (!f) {
    return (
      <div className="empty-main">
        <div className="empty-art">👥</div>
        <h2>Friends</h2>
        <p className="muted">
          Pick a friend on the left to see what they're up to, or add someone by
          their username.
        </p>
      </div>
    );
  }
  const user = { ...f.user, ...live };
  const saveNote = () => {
    if (note === (f.note ?? "")) return;
    api(`/api/friends/${user.id}`, { method: "PATCH", body: { note } }).catch(
      (e) => toast(e.message, "error"),
    );
  };
  const statusText =
    status === "offline"
      ? "Offline"
      : status === "dnd"
        ? "Do not disturb"
        : status === "idle"
          ? "Away"
          : "Online";
  return (
    <ProfileCard
      user={user}
      banner={profile?.banner}
      bio={f.state === "friend" ? profile?.bio : undefined}
      status={f.state === "friend"}
    >
      {f.state === "friend" ? (
        <>
          <div className="friend-status">
            {statusText}
            {game && status !== "offline" && (
              <span className="playing">
                {" "}
                · 🎮 Playing <b>{game}</b>
              </span>
            )}
          </div>
          {voiceCh && (
            <div className="friend-voice">
              <Icon name="speaker" size={16} />
              <span className="grow ellipsis">
                In{" "}
                {voiceCh.kind === "party"
                  ? `the party ${voiceCh.name}`
                  : voiceCh.kind === "dm"
                    ? "a call"
                    : `${voiceCh.name}${voiceGuild ? ` on ${voiceGuild.name}` : ""}`}
              </span>
              {!inMyCall && voiceCh.kind !== "dm" && (
                <button
                  className="btn small green"
                  onClick={() => {
                    selectChannel(homeOf(voiceCh), voiceCh.id);
                    joinVoice(voiceCh.id);
                  }}
                >
                  Join
                </button>
              )}
              {inMyCall && (
                <span className="muted small">you're there too</span>
              )}
            </div>
          )}
          <div className="friend-actions">
            <button className="btn primary" onClick={() => message(user.id)}>
              <Icon name="chat" size={16} /> Message
            </button>
            <button className="btn green" onClick={() => call(user.id)}>
              <Icon name="speaker" size={16} /> Call
            </button>
            <button
              className="btn"
              onClick={() => openModal({ kind: "party", with: [user.id] })}
            >
              <Icon name="party" size={16} /> Start a party
            </button>
            <button
              className="btn"
              title="More"
              onClick={(e) =>
                openMenu(e, [
                  {
                    label: `Remove ${user.display_name}`,
                    danger: true,
                    onClick: () => confirmRemove(f),
                  },
                ])
              }
            >
              <Icon name="more" size={16} />
            </button>
          </div>
          {(mutual.length > 0 || parties.length > 0) && (
            <>
              <div className="profile-section">Together in</div>
              <div className="friend-mutual">
                {parties.map((p) => (
                  <button
                    key={p.id}
                    className="friend-chip"
                    onClick={() => selectChannel("@parties", p.id)}
                  >
                    🎉 {p.name}
                  </button>
                ))}
                {mutual
                  .filter((g) => guilds[g])
                  .map((g) => (
                    <button
                      key={g}
                      className="friend-chip"
                      onClick={() => openGuildView(g)}
                    >
                      {guilds[g].name}
                    </button>
                  ))}
              </div>
            </>
          )}
          <div className="profile-section">Your note (only you see this)</div>
          <textarea
            className="friend-note"
            value={note}
            maxLength={500}
            placeholder="Plays Tuesdays, likes co-op…"
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
          />
          <div className="muted small">
            Friends since {new Date(f.since).toLocaleDateString()}
          </div>
        </>
      ) : f.state === "incoming" ? (
        <div className="friend-actions">
          <span className="grow">{user.display_name} wants to be friends.</span>
          <button className="btn green" onClick={() => accept(f)}>
            Accept
          </button>
          <button
            className="btn"
            onClick={() => removeFriend(f, "Request declined")}
          >
            Decline
          </button>
        </div>
      ) : (
        <div className="friend-actions">
          <span className="grow muted">
            Request sent. You'll be friends once they accept.
          </span>
          <button
            className="btn"
            onClick={() => removeFriend(f, "Request cancelled")}
          >
            Cancel request
          </button>
        </div>
      )}
    </ProfileCard>
  );
}

/** Parties, in the left panel. */
export function PartiesSidebar() {
  const channels = useStore((s) => s.channels);
  const selected = useStore((s) => currentChannelId(s));
  const parties = Object.values(channels)
    .filter((c) => c.kind === "party")
    .sort((a, b) =>
      (b.last_message_id || b.id).localeCompare(a.last_message_id || a.id),
    );
  return (
    <>
      <div className="sidebar-header static">
        <span className="grow">Parties</span>
        <button
          className="icon-btn small"
          title="New party"
          onClick={() => openModal({ kind: "party" })}
        >
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="channel-scroll">
        {parties.map((p) => (
          <PartyRow key={p.id} ch={p} active={selected === p.id} />
        ))}
        {parties.length === 0 && (
          <p className="muted small pad">
            A party is a small group with its own chat and voice room. Press +
            to start one.
          </p>
        )}
      </div>
    </>
  );
}

function PartyRow({ ch, active }: { ch: Channel; active: boolean }) {
  const unread = useStore((s) => isUnread(ch, s));
  const mentions = useStore((s) => s.mentions[ch.id] || 0);
  const inVoice = useStore(
    (s) =>
      Object.values(s.voiceStates).filter((x) => x.channel_id === ch.id).length,
  );
  return (
    <div
      className={
        "dm-row" + (active ? " active" : "") + (unread ? " unread" : "")
      }
      onClick={() => selectChannel("@parties", ch.id)}
      onContextMenu={(e) => openMenu(e, partyMenuItems(ch))}
    >
      <div className="avatar-fallback round party-av">
        {ch.name.slice(0, 2).toUpperCase()}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{ch.name}</div>
        <div className="muted small ellipsis">
          {inVoice
            ? `🔊 ${inVoice} in voice`
            : `${ch.recipients?.length ?? 0} people`}
        </div>
      </div>
      {mentions > 0 && <span className="badge inline">{mentions}</span>}
    </div>
  );
}

/** Parties, with none open. */
export function PartiesEmpty() {
  return (
    <div className="empty-main">
      <div className="empty-art">🎉</div>
      <h2>Parties</h2>
      <p className="muted">
        A party is a small group with its own chat and voice room, outside any
        server. Good for playing something or watching something together.
      </p>
      <button
        className="btn green"
        onClick={() => openModal({ kind: "party" })}
      >
        Start a party
      </button>
    </div>
  );
}

/** Make a party, or add people to one. */
export function PartyModal({
  partyId,
  with: preset,
}: {
  partyId?: string;
  with?: string[];
}) {
  const party = useStore((s) => (partyId ? s.channels[partyId] : undefined));
  const friends = useStore((s) => s.friends);
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const already = useMemo(
    () => new Set((party?.recipients || []).map((r) => r.id)),
    [party],
  );
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(preset || []);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  // friends first, then everyone else you share a server or DM with
  const people = useMemo(() => {
    const fr = Object.values(friends)
      .filter((f) => f.state === "friend")
      .map((f) => ({ ...f.user, ...users[f.user.id] }) as User);
    const others = Object.values(users).filter(
      (u) => u.id !== me.id && !u.is_bot && !friends[u.id]?.state,
    );
    return [
      ...fr,
      ...others.sort((a, b) => a.display_name.localeCompare(b.display_name)),
    ]
      .filter((u) => !already.has(u.id))
      .filter(
        (u) =>
          !q ||
          (u.display_name + " " + u.username)
            .toLowerCase()
            .includes(q.toLowerCase()),
      );
  }, [friends, users, me.id, already, q]);
  const room = PARTY_MAX - (party ? already.size : 1);

  const go = async () => {
    setBusy(true);
    try {
      if (party) {
        for (const id of picked)
          await api(`/api/parties/${party.id}/members/${id}`, {
            method: "PUT",
          });
        toast(picked.length === 1 ? "Added" : `Added ${picked.length} people`);
      } else {
        const p = await api("/api/parties", {
          body: { name: name.trim(), user_ids: picked },
        });
        selectChannel("@parties", p.id);
      }
      closeModal();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal party-modal">
      <h2>{party ? `Add people to ${party.name}` : "New party"}</h2>
      {!party && (
        <>
          <p className="muted small">
            A small group with its own chat and voice room, outside any server.
            Good for playing something or watching something together.
          </p>
          <label>
            Name
            <input
              autoFocus
              value={name}
              maxLength={60}
              placeholder="Raid crew"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        </>
      )}
      <input
        className="party-search"
        value={q}
        placeholder="Find people"
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="party-people">
        {people.length === 0 && (
          <p className="muted small pad">
            Nobody to add. Add friends first, or invite people to one of your
            servers.
          </p>
        )}
        {people.map((u) => {
          const on = picked.includes(u.id);
          return (
            <label key={u.id} className={"party-person" + (on ? " on" : "")}>
              <input
                type="checkbox"
                checked={on}
                disabled={!on && picked.length >= room}
                onChange={() =>
                  setPicked(
                    on ? picked.filter((x) => x !== u.id) : [...picked, u.id],
                  )
                }
              />
              <Avatar user={u} size={28} status />
              <span className="grow ellipsis">{u.display_name}</span>
              {friends[u.id]?.state === "friend" && (
                <span className="muted small">friend</span>
              )}
            </label>
          );
        })}
      </div>
      <div className="modal-actions">
        <span className="muted small grow">
          {picked.length ? `${picked.length} picked` : ""}
        </span>
        <button className="btn" onClick={() => closeModal()}>
          Cancel
        </button>
        <button
          className="btn green"
          disabled={busy || (party ? !picked.length : !name.trim())}
          onClick={go}
        >
          {party ? "Add" : "Start party"}
        </button>
      </div>
    </div>
  );
}

/** A party: its chat, with its voice room on top while you're in it. */
export function PartyView({ channel }: { channel: Channel }) {
  const inCall = useVoice((v) => v.channelId === channel.id);
  if (!inCall) return <ChatView key={channel.id} channel={channel} />;
  return (
    <div className="party-split">
      <div className="party-stage">
        <VoiceView channel={channel} />
      </div>
      <div className="party-chat">
        <ChatView key={channel.id} channel={channel} />
      </div>
    </div>
  );
}

/** Who's in a party (the member list button in a party). */
export function PartyMembers({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me)!;
  const users = useStore((s) => s.users);
  const voice = useStore((s) => s.voiceStates);
  const owner = channel.owner_id === me.id;
  const people = (channel.recipients || []).map((r) => ({
    ...r,
    ...users[r.id],
  }));
  return (
    <aside className="member-list party-members">
      <div className="member-group">In this party — {people.length}</div>
      {people.map((u) => (
        <div key={u.id} className="member">
          <Avatar user={u} size={32} status />
          <span className="ellipsis grow">
            {u.display_name}
            {u.id === channel.owner_id && (
              <span className="muted small"> · made it</span>
            )}
          </span>
          {voice[u.id]?.channel_id === channel.id && (
            <Icon name="speaker" size={16} className="green" />
          )}
          {owner && u.id !== me.id && (
            <button
              className="icon-btn small"
              title={`Remove ${u.display_name}`}
              onClick={() => partyRemove(channel, u.id, u.display_name)}
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      ))}
      {people.length < PARTY_MAX && (
        <button
          className="btn small"
          style={{ margin: 8 }}
          onClick={() => openModal({ kind: "party", partyId: channel.id })}
        >
          Add people
        </button>
      )}
    </aside>
  );
}

function partyRemove(channel: Channel, userId: string, name: string) {
  api(`/api/parties/${channel.id}/members/${userId}`, { method: "DELETE" })
    .then(() => toast(`${name} removed`))
    .catch((e) => toast(e.message, "error"));
}

/** The ⋯ menu items for a party. */
export function partyMenuItems(channel: Channel) {
  const me = useStore.getState().me!;
  const owner = channel.owner_id === me.id;
  const items: { label: string; onClick: () => void; danger?: boolean }[] = [
    {
      label: "Add people",
      onClick: () => openModal({ kind: "party", partyId: channel.id }),
    },
    {
      label: "Ring everyone",
      onClick: () => {
        if (useVoice.getState().channelId !== channel.id) joinVoice(channel.id);
        api(`/api/channels/${channel.id}/ring`, { method: "POST" }).catch(
          () => {},
        );
      },
    },
  ];
  if (owner)
    items.push({
      label: "Rename party",
      onClick: () =>
        openModal({
          kind: "prompt",
          title: "Rename party",
          label: "Name",
          initial: channel.name,
          confirmLabel: "Rename",
          onSubmit: (v) =>
            api(`/api/parties/${channel.id}`, {
              method: "PATCH",
              body: { name: v },
            }).then(() => {}),
        }),
    });
  items.push({
    label: "Leave party",
    danger: true,
    onClick: () =>
      openModal({
        kind: "confirm",
        title: "Leave party",
        body: `Leave ${channel.name}? Someone in it can add you back.`,
        danger: true,
        confirmLabel: "Leave",
        onConfirm: async () => {
          await api(`/api/parties/${channel.id}/members/${me.id}`, {
            method: "DELETE",
          });
          selectChannel("@parties", null);
        },
      }),
  });
  if (owner)
    items.push({
      label: "Delete party",
      danger: true,
      onClick: () =>
        openModal({
          kind: "confirm",
          title: "Delete party",
          body: `Delete ${channel.name} and its chat for everyone? You can always start a new one.`,
          danger: true,
          confirmLabel: "Delete",
          onConfirm: async () => {
            await api(`/api/parties/${channel.id}`, { method: "DELETE" });
            selectChannel("@parties", null);
          },
        }),
    });
  return items;
}
