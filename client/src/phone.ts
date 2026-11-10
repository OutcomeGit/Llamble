import { useEffect, useState } from "react";

/** Narrow screens (phones) get the one-panel-at-a-time layout. Matches the CSS breakpoint. */
export const PHONE_QUERY = "(max-width: 760px)";

export function isPhone() {
  return typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;
}

export function useIsPhone() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const m = matchMedia(PHONE_QUERY);
    const f = () => setPhone(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return phone;
}
