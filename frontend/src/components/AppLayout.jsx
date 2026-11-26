import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import Navbar from "./Navbar.jsx";
import Sidebar from "./Sidebar.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function AppLayout() {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuButtonRef = useRef(null);
  const firstLinkRef = useRef(null);
  const wasMobileOpen = useRef(false);

  useEffect(() => {
    if (!mobileOpen) {
      if (wasMobileOpen.current) {
        wasMobileOpen.current = false;
        menuButtonRef.current?.focus();
      }
      return;
    }
    wasMobileOpen.current = true;
    firstLinkRef.current?.focus();
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-slate-50 lg:flex">
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <Sidebar
        user={user}
        mobileOpen={mobileOpen}
        firstLinkRef={firstLinkRef}
        onNavigate={() => setMobileOpen(false)}
      />
      <div className="min-w-0 flex-1">
        <Navbar
          mobileOpen={mobileOpen}
          menuButtonRef={menuButtonRef}
          onMenuClick={() => setMobileOpen((open) => !open)}
        />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-7 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
