import { Elysia } from "elysia";
import { denied } from "../../storage/broker-boundary.ts";
import type { StorageBrokerDependencies } from "../../storage/broker-contracts.ts";
import { StorageHealthController } from "./health/controller.ts";
import { createPrivateBlobController } from "./private/blob/controller.ts";
import { createPrivateMarkdownBlobController } from "./private/markdown-blob/controller.ts";
import { createPrivatePublicationArtifactController } from "./private/publication-artifact/controller.ts";
import { createPrivateVerifyController } from "./private/verify/controller.ts";
import { createPublicRepresentationController } from "./public/representation/controller.ts";

export function createStorageBrokerApp(dependencies: StorageBrokerDependencies) {
  const context = { ...dependencies, activeWrites: new Set<string>() };
  return new Elysia({ serve: { maxRequestBodySize: 5_500_000_000 } })
    .onError(() => denied())
    .use(StorageHealthController)
    .use(createPrivateBlobController(context))
    .use(createPrivateMarkdownBlobController(context))
    .use(createPrivatePublicationArtifactController(context))
    .use(createPrivateVerifyController(context))
    .use(createPublicRepresentationController(context));
}
