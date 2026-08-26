import type {
  PublicationRepository,
  PublicEntrypointRepository,
} from "@context-use/database/publication";
import type { PublicationEntrypointInput, PublicationIntentInput } from "@context-use/shared";
import type { DashboardPrincipal } from "../auth-client.ts";
import type { issueConfirmationOptions } from "../confirmation-client.ts";

type PublicationStorage = {
  materializePublicationArtifact(intentId: string): Promise<void>;
};

type IssueConfirmation = typeof issueConfirmationOptions;

export class DashboardPublicationService {
  constructor(
    private readonly dependencies: {
      publications: PublicationRepository;
      entrypoint: PublicEntrypointRepository;
      storage: PublicationStorage;
      issueConfirmation: IssueConfirmation;
    },
  ) {}

  async begin({
    input,
    principal,
    intentId,
  }: {
    input: PublicationIntentInput;
    principal: DashboardPrincipal;
    intentId?: string;
  }) {
    const intent = await this.dependencies.publications.begin({
      intent: input,
      principal: {
        ownerUserId: principal.userId,
        sessionId: principal.sessionId,
      },
      ...(intentId === undefined ? {} : { intentId }),
    });
    if (intent.action === "publish") {
      await this.dependencies.storage.materializePublicationArtifact(intent.id);
    }
    const authenticationOptions = await this.dependencies.issueConfirmation(
      "publication",
      intent.id,
    );
    return { intent, authentication_options: authenticationOptions };
  }

  async cancel({ intentId, principal }: { intentId: string; principal: DashboardPrincipal }) {
    await this.dependencies.publications.cancel({
      intentId,
      principal: {
        ownerUserId: principal.userId,
        sessionId: principal.sessionId,
      },
    });
    return { cancelled: true as const };
  }

  async entrypoint() {
    return { entrypoint: await this.dependencies.entrypoint.get() };
  }

  async entrypointCandidates() {
    const candidates = (await this.dependencies.entrypoint.candidates()).map(
      ({ representation_token: _representationToken, ...candidate }) => candidate,
    );
    return { candidates };
  }

  async setEntrypoint(input: PublicationEntrypointInput) {
    return { entrypoint: await this.dependencies.entrypoint.set(input) };
  }
}
