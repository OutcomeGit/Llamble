// Profile pages: yours (Home → My profile) and other people's (Friends → pick someone).
// Server: GET /api/users/{id}/profile, PATCH /api/users/@me/profile (server/src/api/social.rs).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, upload } from "../api";
import { onEvent, useStore } from "../store";
import type { User } from "../types";
import { toast } from "../ui";
import { Avatar } from "./common";

/** Banner colors, the same palette as the boards. */
export const BANNERS: { id: string; label: string; css: string }[] = [
  {
    id: "",
    label: "Llamble",
    css: "linear-gradient(135deg, #5865f2, #3ba55d)",
  },
  {
    id: "gray",
    label: "Gray",
    css: "linear-gradient(135deg, #4e5058, #2b2d31)",
  },
  {
    id: "cork",
    label: "Cork",
    css: "linear-gradient(135deg, #c99a68, #8a5e33)",
  },
  {
    id: "spit",
    label: "Llama green",
    css: "linear-gradient(135deg, #9bd77a, #5c9a3a)",
  },
  { id: "sky", label: "Sky", css: "linear-gradient(135deg, #b4dcf6, #5fa8dc)" },
  {
    id: "lavender",
    label: "Lavender",
    css: "linear-gradient(135deg, #cfc0f2, #8f74d8)",
  },
  {
    id: "sunset",
    label: "Sunset",
    css: "linear-gradient(135deg, #f7bf85, #e0743a)",
  },
  {
    id: "midnight",
    label: "Midnight",
    css: "linear-gradient(135deg, #3b4a70, #16203a)",
  },
  {
    id: "chalkboard",
    label: "Chalkboard",
    css: "linear-gradient(135deg, #3a4d40, #1c2820)",
  },
];
export const bannerCss = (id?: string) =>
  (BANNERS.find((b) => b.id === (id || "")) ?? BANNERS[0]).css;

export interface Profile {
  user: User;
  bio: string;
  banner: string;
  joined_at: number;
}

/** Someone's profile, kept fresh when they change it. */
export function useProfile(userId: string | null | undefined): Profile | null {
  const [p, setP] = useState<Profile | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(
    () =>
      onEvent(
        (t, d) =>
          t === "USER_UPDATE" && d?.id === userId && setTick((n) => n + 1),
      ),
    [userId],
  );
  useEffect(() => {
    setP(null);
    if (!userId) return;
    let gone = false;
    api(`/api/users/${userId}/profile`)
      .then((v) => !gone && setP(v))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [userId, tick]);
  return p;
}

/** The card: banner, picture, name, about me, then whatever the page adds. */
export function ProfileCard({
  user,
  banner,
  bio,
  status = true,
  onAvatar,
  children,
}: {
  user: User;
  banner?: string;
  bio?: string;
  status?: boolean;
  onAvatar?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="friend-page">
      <div className="friend-card">
        <div
          className="profile-banner"
          style={{ background: bannerCss(banner) }}
        />
        <div
          className={"profile-avatar" + (onAvatar ? " clickable" : "")}
          onClick={onAvatar}
          title={onAvatar ? "Change picture" : undefined}
        >
          <Avatar user={user} size={96} status={status} />
        </div>
        <div className="friend-card-body">
          <h2>{user.display_name}</h2>
          <div className="muted">@{user.username}</div>
          {bio ? <div className="profile-bio">{bio}</div> : null}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Home → My profile: how others see you, and where you change it. */
export function MyProfile() {
  const me = useStore((s) => s.me)!;
  const p = useProfile(me.id);
  const [name, setName] = useState(me.display_name);
  const [bio, setBio] = useState("");
  const [banner, setBanner] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!p) return;
    setBio(p.bio);
    setBanner(p.banner);
  }, [p]);
  useEffect(() => setName(me.display_name), [me.display_name]);
  const dirty =
    !!p &&
    (bio !== p.bio || banner !== p.banner || name.trim() !== me.display_name);
  const save = async () => {
    setSaving(true);
    try {
      if (name.trim() !== me.display_name)
        await api("/api/users/@me", {
          method: "PATCH",
          body: { display_name: name },
        });
      await api("/api/users/@me/profile", {
        method: "PATCH",
        body: { bio, banner },
      });
      toast("Profile saved");
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setSaving(false);
    }
  };
  const setAvatar = async (f: File) => {
    try {
      const fo = await upload(f, f.name);
      await api("/api/users/@me", {
        method: "PATCH",
        body: { avatar_file_id: fo.id },
      });
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <ProfileCard
      user={{ ...me, display_name: name.trim() || me.display_name }}
      banner={banner}
      bio={bio.trim()}
      onAvatar={() => fileRef.current?.click()}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => e.target.files?.[0] && setAvatar(e.target.files[0])}
      />
      <div className="muted small">
        This is how your profile looks to others. Click your picture to change
        it.
      </div>
      <div className="profile-section">Display name</div>
      <input
        value={name}
        maxLength={32}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="profile-section">About me</div>
      <textarea
        className="friend-note"
        value={bio}
        maxLength={300}
        placeholder="A few words: what you play, what you're into, when you're around…"
        onChange={(e) => setBio(e.target.value)}
      />
      <div className="muted small right">{bio.length}/300</div>
      <div className="profile-section">Banner</div>
      <div className="banner-picks">
        {BANNERS.map((b) => (
          <button
            key={b.id}
            className={"banner-pick" + (banner === b.id ? " on" : "")}
            title={b.label}
            style={{ background: b.css }}
            onClick={() => setBanner(b.id)}
          />
        ))}
      </div>
      <div className="friend-actions">
        <button
          className="btn primary"
          disabled={!dirty || saving || !name.trim()}
          onClick={save}
        >
          Save
        </button>
        {dirty && (
          <button
            className="btn"
            onClick={() => {
              setName(me.display_name);
              setBio(p!.bio);
              setBanner(p!.banner);
            }}
          >
            Undo changes
          </button>
        )}
        {p && (
          <span className="muted small">
            On Llamble since {new Date(p.joined_at).toLocaleDateString()}
          </span>
        )}
      </div>
    </ProfileCard>
  );
}
