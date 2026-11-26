import { useEffect, useState } from "react";

export default function DemoToast() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    let timer;
    const show = (event) => {
      setMessage(event.detail?.message ?? "Synthetic demo data updated.");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setMessage(""), 3600);
    };
    window.addEventListener("kristallball:demo-toast", show);
    return () => {
      window.removeEventListener("kristallball:demo-toast", show);
      window.clearTimeout(timer);
    };
  }, []);

  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 top-20 z-50 max-w-sm rounded-lg border border-emerald-200 bg-white px-4 py-3 text-sm font-medium text-emerald-950 shadow-lg sm:right-6"
    >
      {message}
    </div>
  );
}
