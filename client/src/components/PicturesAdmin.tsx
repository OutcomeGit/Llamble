import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../ui";
import { Toggle } from "./common";

/** Master Admin: making pictures (FLUX.2 klein / Z-Image) on lent GPUs and the NAS. */
export function PicturesAdmin() {
  const [d, setD] = useState<any>(null);
  const load = () => api("/api/admin/images").then(setD).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, []);
  if (!d) return null;
  const s = d.settings;
  const st = d.status;
  const save = (patch: any) =>
    api("/api/admin/images", { method: "PUT", body: patch })
      .then(setD)
      .catch((e) => toast(e.message, "error"));
  const pct = st.total_bytes ? Math.round((st.done_bytes / st.total_bytes) * 100) : 0;
  return (
    <div>
      <div className="profile-section">Pictures</div>
      <p className="muted small">
        People type <code>/imagine a llama surfing a giant wave</code>, or ask the AI to draw something, and the picture appears in the chat. It's made on a member's lent GPU (seconds) when one offers pictures, otherwise on this NAS (slow).
      </p>
      <div className="perm-row">
        <div>
          <div className="bold">Allow making pictures</div>
        </div>
        <Toggle on={s.enabled} onChange={(v) => save({ enabled: v })} />
      </div>
      {s.enabled && (
        <>
          <label>
            Model
            <select value={s.model} onChange={(e) => save({ model: e.target.value })}>
              {d.models.map((m: any) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Who can make pictures
            <select value={s.who} onChange={(e) => save({ who: e.target.value })}>
              <option value="adults">Everyone except kid accounts</option>
              <option value="everyone">Everyone, kids too</option>
              <option value="admins">Admins only</option>
            </select>
          </label>
          <p className="muted small">Pictures are kept family-friendly: requests for nudity or gore are refused.</p>
          <div className={"rs " + (d.lent_gpus.length ? "ok" : "off")}>
            <b>Lent GPUs for pictures:</b>{" "}
            {d.lent_gpus.length ? d.lent_gpus.map((g: any) => `${g.gpu}${g.available ? "" : " (paused)"}`).join(", ") : "none right now — in the Windows app: My Settings → Lend My GPU → Also make pictures"}
          </div>
          <div className="perm-row">
            <div>
              <div className="bold">Draw on this NAS when no GPU is lent</div>
              <div className="muted small">Downloads the model to the NAS (~6–7 GB). Takes about 1–3 minutes per picture with the NAS's graphics, several minutes on its processor alone.</div>
            </div>
            <Toggle on={s.nas} onChange={(v) => save({ nas: v })} />
          </div>
          {s.nas && (
            <>
              <div className={"rs " + (st.state === "ready" ? "ok" : st.error ? "err" : "off")}>
                <b>Model on the NAS:</b>{" "}
                {st.state === "downloading" ? `downloading ${st.file}… ${pct}%` : st.error ? st.error : st.state === "ready" ? (st.busy ? "ready (drawing now)" : "ready") : "waiting to download"}
              </div>
              {!d.nas_tool && <p className="error-text small">This server build doesn't include the drawing tool. Update the Llamble image.</p>}
              <div className={"rs " + (d.nas_gpu === "ready" ? "ok" : "off")}>
                <b>NAS graphics:</b>{" "}
                {d.nas_gpu === "ready" ? (
                  "in use (Intel/AMD built-in graphics via Vulkan)"
                ) : d.nas_gpu === "no-access" ? (
                  <>
                    found but not allowed. In the TrueNAS YAML, under <code>llamble:</code>, add <code>group_add: ["{d.nas_gpu_gid}"]</code> and save.
                  </>
                ) : (
                  <>
                    not shared with Llamble, so it uses the processor. To use them, in TrueNAS → Apps → Llamble → Edit, add under <code>llamble:</code>
                    <pre className="yaml-snippet">{`    devices:\n      - /dev/dri:/dev/dri`}</pre>
                    then save. Llamble will show the next step here if one is needed.
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
