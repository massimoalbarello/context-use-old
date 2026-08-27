import type {
  ConfirmationIntentKind,
  ConfirmationPasskey,
  ConfirmationRepository,
} from "@context-use/database";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

const ownerUserId = "context-use-owner";

export type ConfirmationPrincipal = {
  owner_user_id: typeof ownerUserId;
  session_id: string;
};

export type BrowserConfirmation = {
  principal: ConfirmationPrincipal;
  confirmation: {
    intent_id: string;
    response: AuthenticationResponseJSON;
  };
};

export type BrowserConfirmationKind = "publication" | "page_deletion";

export type BrowserConfirmationResult =
  | { state: "confirmed"; body: Record<string, unknown> }
  | { state: "not_found"; message: string }
  | { state: "inactive"; message: string }
  | { state: "passkey_invalid" };

export type ConfirmationStore = Pick<
  ConfirmationRepository,
  | "passkeys"
  | "issueChallenge"
  | "publicationIntent"
  | "confirmPublication"
  | "pageDeletionIntent"
  | "confirmPageDeletion"
>;

export class ConfirmationService {
  constructor(
    private readonly dependencies: {
      confirmations: ConfirmationStore;
      appOrigin: string;
      rpId: string;
    },
  ) {}

  async options({ kind, intentId }: { kind: ConfirmationIntentKind; intentId: string }) {
    const passkeys = await this.dependencies.confirmations.passkeys(ownerUserId);
    if (!passkeys.length) {
      return null;
    }
    const options = await generateAuthenticationOptions({
      rpID: this.dependencies.rpId,
      userVerification: "required",
      timeout: 300_000,
      allowCredentials: passkeys.map((key) => {
        const keyTransports = transports(key.transports);
        return { id: key.credentialID, ...(keyTransports ? { transports: keyTransports } : {}) };
      }),
    });
    await this.dependencies.confirmations.issueChallenge(kind, intentId, options.challenge);
    return options;
  }

  confirm({ kind, input }: { kind: BrowserConfirmationKind; input: BrowserConfirmation }) {
    switch (kind) {
      case "publication":
        return this.confirmPublication(input);
      case "page_deletion":
        return this.confirmPageDeletion(input);
    }
  }

  private async verifiedPasskey({
    response,
    expectedChallenge,
  }: {
    response: AuthenticationResponseJSON;
    expectedChallenge: string;
  }): Promise<{ key: ConfirmationPasskey; newCounter: number } | null> {
    const key = (await this.dependencies.confirmations.passkeys(ownerUserId)).find(
      (candidate) => candidate.credentialID === response.id,
    );
    if (!key) {
      return null;
    }
    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: this.dependencies.appOrigin,
        expectedRPID: this.dependencies.rpId,
        credential: {
          id: key.credentialID,
          publicKey: Buffer.from(key.publicKey, "base64"),
          counter: key.counter,
          ...(() => {
            const keyTransports = transports(key.transports);
            return keyTransports ? { transports: keyTransports } : {};
          })(),
        },
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.authenticationInfo.userVerified) {
        return null;
      }
      return { key, newCounter: verification.authenticationInfo.newCounter };
    } catch {
      return null;
    }
  }

  private async confirmPublication(input: BrowserConfirmation): Promise<BrowserConfirmationResult> {
    const intent = await this.dependencies.confirmations.publicationIntent(
      input.confirmation.intent_id,
    );
    if (!intent || !ownsIntent({ intent, principal: input.principal })) {
      return { state: "not_found", message: "Publication intent not found" };
    }
    if (!intent.challenge || expired(intent.expires_at)) {
      return { state: "inactive", message: "Publication intent is inactive" };
    }
    const verified = await this.verifiedPasskey({
      response: input.confirmation.response,
      expectedChallenge: intent.challenge,
    });
    if (!verified) {
      return { state: "passkey_invalid" };
    }
    await this.dependencies.confirmations.confirmPublication(
      intent.id,
      repositoryPrincipal(input.principal),
      counterUpdate(verified),
    );
    return {
      state: "confirmed",
      body: {
        published: intent.action !== "unpublish",
        action: intent.action,
        target_kind: intent.target_kind,
        target_id: intent.target_id,
      },
    };
  }

  private async confirmPageDeletion(
    input: BrowserConfirmation,
  ): Promise<BrowserConfirmationResult> {
    const intent = await this.dependencies.confirmations.pageDeletionIntent(
      input.confirmation.intent_id,
    );
    if (!intent || !ownsIntent({ intent, principal: input.principal })) {
      return { state: "not_found", message: "Page deletion intent not found" };
    }
    if (!intent.challenge || expired(intent.expires_at)) {
      return { state: "inactive", message: "Page deletion intent is inactive" };
    }
    const verified = await this.verifiedPasskey({
      response: input.confirmation.response,
      expectedChallenge: intent.challenge,
    });
    if (!verified) {
      return { state: "passkey_invalid" };
    }
    await this.dependencies.confirmations.confirmPageDeletion(
      intent.id,
      repositoryPrincipal(input.principal),
      counterUpdate(verified),
    );
    return { state: "confirmed", body: { deleted: true, page_id: intent.page_id } };
  }
}

function transports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  const parsed = value?.split(",").filter(Boolean) as AuthenticatorTransportFuture[] | undefined;
  return parsed?.length ? parsed : undefined;
}

function ownsIntent({
  intent,
  principal,
}: {
  intent: { owner_user_id: string; session_id: string } | null;
  principal: ConfirmationPrincipal;
}): boolean {
  return Boolean(
    intent &&
      intent.owner_user_id === principal.owner_user_id &&
      intent.session_id === principal.session_id,
  );
}

function expired(value: Date | string): boolean {
  return new Date(value).getTime() <= Date.now();
}

function repositoryPrincipal(principal: ConfirmationPrincipal) {
  return { ownerUserId: principal.owner_user_id, sessionId: principal.session_id };
}

function counterUpdate(verified: { key: ConfirmationPasskey; newCounter: number }) {
  return {
    credentialId: verified.key.credentialID,
    expectedCounter: verified.key.counter,
    newCounter: verified.newCounter,
  };
}
