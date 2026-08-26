import type {
  AutomationRegistryRepository,
  PrivateObjectCatalogRepository,
  SourceRecordRepository,
} from "@context-use/database";
import {
  dashboardObjectCatalogPage,
  dashboardObjectNeighborhood,
  dashboardObjectSummary,
  parseDashboardObjectCatalogQuery,
  parseDashboardObjectNeighborhoodQuery,
} from "../dashboard-object-discovery.ts";
import { dashboardSourceRecord } from "../dashboard-source-records.ts";
import type { DashboardRenderingService } from "./dashboard-rendering-service.ts";

export type SourceRecordMutationResult =
  | { state: "found"; record: ReturnType<typeof dashboardSourceRecord> }
  | { state: "not_found" }
  | { state: "revision_conflict" }
  | { state: "not_archived" };

export class DashboardObjectsService {
  constructor(
    private readonly dependencies: {
      objects: PrivateObjectCatalogRepository;
      automations: AutomationRegistryRepository;
      sourceRecords: SourceRecordRepository;
      rendering: DashboardRenderingService;
    },
  ) {}

  async catalog(query: Record<string, string | undefined>) {
    const parsed = parseDashboardObjectCatalogQuery(query);
    const page = parsed.query
      ? await this.dependencies.objects.search(parsed.query, parsed.options)
      : await this.dependencies.objects.list(parsed.options);
    return dashboardObjectCatalogPage(page);
  }

  async automations() {
    const registrations = await this.dependencies.automations.listActive();
    return {
      automations: await Promise.all(
        registrations.map(async (registration) => {
          const instructions = await this.dependencies.objects.get(
            registration.instructions_document_id,
          );
          return {
            id: registration.id,
            name: registration.name,
            instructions: instructions ? dashboardObjectSummary(instructions) : null,
          };
        }),
      ),
    };
  }

  async get(objectId: string) {
    const object = await this.dependencies.objects.get(objectId);
    return object ? dashboardObjectSummary(object) : null;
  }

  async neighborhood({
    objectId,
    query,
  }: {
    objectId: string;
    query: Record<string, string | undefined>;
  }) {
    const neighborhood = await this.dependencies.objects.neighborhood(
      objectId,
      parseDashboardObjectNeighborhoodQuery(query),
    );
    return neighborhood ? dashboardObjectNeighborhood(neighborhood) : null;
  }

  async sourceRecord(objectId: string) {
    const record = await this.dependencies.sourceRecords.get(objectId);
    if (!record) {
      return null;
    }
    const renderedHtml =
      record.body_markdown === null
        ? ""
        : await this.dependencies.rendering.render(record.body_markdown);
    return dashboardSourceRecord(record, renderedHtml);
  }

  async archiveSourceRecord({
    objectId,
    expectedRevisionId,
  }: {
    objectId: string;
    expectedRevisionId: string | null;
  }): Promise<SourceRecordMutationResult> {
    const result = await this.dependencies.sourceRecords.archive(objectId, expectedRevisionId);
    if (result !== "archived") {
      return { state: result };
    }
    const record = await this.sourceRecord(objectId);
    return record ? { state: "found", record } : { state: "not_found" };
  }

  async deleteSourceRecord({
    objectId,
    expectedRevisionId,
  }: {
    objectId: string;
    expectedRevisionId: string | null;
  }): Promise<SourceRecordMutationResult | { state: "deleted"; objectId: string }> {
    const result = await this.dependencies.sourceRecords.delete(objectId, expectedRevisionId);
    return result === "deleted" ? { state: "deleted", objectId } : { state: result };
  }
}
