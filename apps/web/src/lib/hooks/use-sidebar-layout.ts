import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

const SIDEBAR_WIDTH_STORAGE_KEY = "context-use.sidebar.width.v1";
const SIDEBAR_OPEN_STORAGE_KEY = "context-use.sidebar.open.v1";
const MOBILE_LAYOUT_QUERY = "(max-width: 960px)";
export const DEFAULT_SIDEBAR_WIDTH = 258;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 520;

const clampSidebarWidth = (width: number) =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));

function restoredSidebarWidth() {
  try {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) && stored > 0
      ? clampSidebarWidth(stored)
      : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function restoredSidebarOpen() {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function useSidebarLayout() {
  const [sidebarWidth, setSidebarWidth] = useState(restoredSidebarWidth);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(restoredSidebarOpen);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileSidebarToggleRef = useRef<HTMLButtonElement>(null);
  const mobileSidebarCloseRef = useRef<HTMLButtonElement>(null);
  const resizeStart = useRef({ pointerX: 0, width: DEFAULT_SIDEBAR_WIDTH });

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") {
        return;
      }
      event.preventDefault();
      if (window.matchMedia(MOBILE_LAYOUT_QUERY).matches) {
        setMobileSidebarOpen(true);
      } else {
        setDesktopSidebarOpen(true);
      }
      window.setTimeout(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Resizing still works when browser storage is unavailable.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_STORAGE_KEY, String(desktopSidebarOpen));
    } catch {
      // The sidebar remains collapsible when browser storage is unavailable.
    }
  }, [desktopSidebarOpen]);

  useEffect(() => {
    if (!resizingSidebar) {
      return;
    }
    const resize = (event: PointerEvent) => {
      const delta = event.clientX - resizeStart.current.pointerX;
      setSidebarWidth(clampSidebarWidth(resizeStart.current.width + delta));
    };
    const stop = () => setResizingSidebar(false);
    document.body.classList.add("resizing-sidebar");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      document.body.classList.remove("resizing-sidebar");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizingSidebar]);

  useEffect(() => {
    if (!mobileSidebarOpen) {
      return;
    }
    const sidebar = sidebarRef.current;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileSidebarOpen(false);
        window.setTimeout(() => mobileSidebarToggleRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !sidebar) {
        return;
      }
      const focusable = [
        ...sidebar.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.body.classList.add("mobile-sidebar-open");
    window.addEventListener("keydown", handleKeyDown);
    window.setTimeout(() => mobileSidebarCloseRef.current?.focus());
    return () => {
      document.body.classList.remove("mobile-sidebar-open");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileSidebarOpen]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    resizeStart.current = { pointerX: event.clientX, width: sidebarWidth };
    setResizingSidebar(true);
    event.preventDefault();
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 30 : 10;
    if (event.key === "ArrowLeft") {
      setSidebarWidth((width) => clampSidebarWidth(width - step));
    } else if (event.key === "ArrowRight") {
      setSidebarWidth((width) => clampSidebarWidth(width + step));
    } else if (event.key === "Home") {
      setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    } else {
      return;
    }
    event.preventDefault();
  };

  return {
    defaultSidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    minSidebarWidth: MIN_SIDEBAR_WIDTH,
    maxSidebarWidth: MAX_SIDEBAR_WIDTH,
    sidebarWidth,
    desktopSidebarOpen,
    mobileSidebarOpen,
    searchRef,
    sidebarRef,
    mobileSidebarToggleRef,
    mobileSidebarCloseRef,
    setDesktopSidebarOpen,
    setMobileSidebarOpen,
    setSidebarWidth,
    startResize,
    resizeWithKeyboard,
  };
}

export type SidebarLayout = ReturnType<typeof useSidebarLayout>;
