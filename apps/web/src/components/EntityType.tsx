import type { PageEntityType } from "@context-use/shared";

export const ENTITY_TYPE_OPTIONS: ReadonlyArray<{
  value: PageEntityType;
  label: string;
}> = [
  { value: "person", label: "Person" },
  { value: "organization", label: "Organization" },
  { value: "place", label: "Place" },
  { value: "event", label: "Event" },
  { value: "thing", label: "Thing" },
];

export function entityTypeLabel(type: PageEntityType): string {
  return ENTITY_TYPE_OPTIONS.find(({ value }) => value === type)!.label;
}

export function EntityTypeIcon({ type }: { type: PageEntityType }) {
  if (type === "person") return <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="10" cy="6.2" r="2.8" />
    <path d="M4.8 16.2c.5-3.2 2.2-4.8 5.2-4.8s4.7 1.6 5.2 4.8" />
  </svg>;
  if (type === "organization") return <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M4 17V5.5L10 3l6 2.5V17M7 7.5h.1M10 7.5h.1M13 7.5h.1M7 11h.1M10 11h.1M13 11h.1M8 17v-2.8h4V17" />
  </svg>;
  if (type === "place") return <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M15.5 8.2c0 4-5.5 8.5-5.5 8.5S4.5 12.2 4.5 8.2a5.5 5.5 0 1 1 11 0Z" />
    <circle cx="10" cy="8.1" r="1.7" />
  </svg>;
  if (type === "event") return <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="3.5" y="4.8" width="13" height="11.5" rx="2" />
    <path d="M6.5 3v3.3M13.5 3v3.3M3.5 8.3h13M7 11.3h.1M10 11.3h.1M13 11.3h.1" />
  </svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="m10 2.8 6 3.4v7L10 17l-6-3.8v-7l6-3.4Z" />
    <path d="m4.2 6.3 5.8 3.4 5.8-3.4M10 9.7V17" />
  </svg>;
}

export function EntityIdentity({ type }: { type: PageEntityType }) {
  return <span className={`entity-identity entity-${type}`}>
    <EntityTypeIcon type={type} />
    <span>{entityTypeLabel(type)}</span>
  </span>;
}

export function EntityTypeField({
  value,
  onChange,
}: {
  value: PageEntityType | null;
  onChange: (value: PageEntityType | null) => void;
}) {
  return <label>Entity type
    <select
      value={value ?? ""}
      onChange={(event) => onChange(
        event.target.value ? event.target.value as PageEntityType : null,
      )}
    >
      <option value="">None — ordinary page</option>
      {ENTITY_TYPE_OPTIONS.map((option) => <option
        key={option.value}
        value={option.value}
      >{option.label}</option>)}
    </select>
    <small>Only for this entity’s canonical introduction.</small>
  </label>;
}
