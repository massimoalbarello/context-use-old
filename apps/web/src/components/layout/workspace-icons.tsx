import type { Section } from "./DashboardSidebar.tsx";

export function SectionIcon({ section }: { section: Section }) {
  if (section === "knowledge") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4.5 3.5h8a3 3 0 0 1 3 3v10h-8a3 3 0 0 1-3-3v-10Z" />
        <path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3" />
      </svg>
    );
  }
  if (section === "automations") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 2.75v3.5M10 13.75v3.5M2.75 10h3.5M13.75 10h3.5" />
        <circle cx="10" cy="10" r="3.75" />
        <path d="m4.9 4.9 2.45 2.45M12.65 12.65l2.45 2.45M15.1 4.9l-2.45 2.45M7.35 12.65 4.9 15.1" />
      </svg>
    );
  }
  if (section === "history") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 4.5h12M4 10h12M4 15.5h12" />
        <circle cx="6" cy="4.5" r="1" />
        <circle cx="10" cy="10" r="1" />
        <circle cx="14" cy="15.5" r="1" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="2.5" />
      <path d="M16.5 11.5v-3l-2-.5a5.1 5.1 0 0 0-.7-1.2l.55-2-2.6-1.5-1.45 1.45a5.3 5.3 0 0 0-1.4 0L7.45 3.3l-2.6 1.5.55 2A5.1 5.1 0 0 0 4.7 8l-2 .5v3l2 .5c.18.43.42.84.7 1.2l-.55 2 2.6 1.5 1.45-1.45a5.3 5.3 0 0 0 1.4 0l1.45 1.45 2.6-1.5-.55-2c.28-.36.52-.77.7-1.2l2-.5Z" />
    </svg>
  );
}

export function SignOutIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8 3.5H4.5v13H8" />
      <path d="M11.5 6.5 15 10l-3.5 3.5M7 10h8" />
    </svg>
  );
}

export function SidebarToggleIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3.5 5.25h13M3.5 10h13M3.5 14.75h13" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" />
    </svg>
  );
}
